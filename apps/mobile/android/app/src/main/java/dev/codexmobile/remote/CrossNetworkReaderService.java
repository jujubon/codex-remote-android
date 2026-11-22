package dev.codexmobile.remote;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Size;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.IntentCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class CrossNetworkReaderService extends Service {
    private static final String CHANNEL = "codex_reader_capture";
    private static final int NOTIFICATION_ID = 9274;
    private static final String STOP = "dev.codexmobile.remote.STOP_READER";
    private static final int MAX_FRAME_BYTES = 160 * 1024;
    private static final int FRAME_INTERVAL = 380;
    private static final MediaType JPEG = MediaType.get("image/jpeg");
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false).callTimeout(4, TimeUnit.SECONDS).build();
    private static volatile String currentState = "idle";
    private static volatile String currentDetail = "";

    static boolean active() { return !"idle".equals(currentState); }
    static String state() { return currentState; }
    static String detail() { return currentDetail; }

    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread thread;
    private Handler worker;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader capture;
    private Bitmap workspace;
    private HttpUrl address;
    private String token;
    private String session;
    private byte[] lastFrame;
    private int density;
    private long lastSend;
    private volatile boolean stopping;
    private volatile Call inFlight;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (thread != null) return START_NOT_STICKY;

        Intent consent = IntentCompat.getParcelableExtra(intent, "consent", Intent.class);
        String endpoint = intent.getStringExtra("address");
        address = endpoint == null ? null : HttpUrl.parse(endpoint);
        if (consent == null || address == null || !address.isHttps()) {
            currentDetail = "请重新授权后开始投屏。";
            stopSelf();
            return START_NOT_STICKY;
        }

        currentDetail = "";
        currentState = "connecting";
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(),
                    Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : 0);
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(Activity.RESULT_OK, consent);
            thread = new HandlerThread("codex-screen-share");
            thread.start();
            worker = new Handler(thread.getLooper());
            Size bounds = screenSize();
            density = Resources.getSystem().getDisplayMetrics().densityDpi;
            worker.post(() -> begin(bounds));
        } catch (RuntimeException error) {
            finish("Android 无法启动屏幕共享，请重新授权。");
        }
        return START_NOT_STICKY;
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "跨网投屏", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent stop = PendingIntent.getService(this, NOTIFICATION_ID,
                new Intent(this, CrossNetworkReaderService.class).setAction(STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_codex_notification)
                .setContentTitle("正在共享屏幕到电脑")
                .setContentText("可在这里结束跨网投屏。")
                .setOngoing(true)
                .addAction(0, "停止投屏", stop)
                .build();
    }

    @SuppressWarnings("deprecation")
    private Size screenSize() {
        WindowManager window = getSystemService(WindowManager.class);
        if (Build.VERSION.SDK_INT >= 30) {
            var bounds = window.getMaximumWindowMetrics().getBounds();
            return new Size(bounds.width(), bounds.height());
        }
        DisplayMetrics metrics = new DisplayMetrics();
        window.getDefaultDisplay().getRealMetrics(metrics);
        return new Size(metrics.widthPixels, metrics.heightPixels);
    }

    private final MediaProjection.Callback callback = new MediaProjection.Callback() {
        @Override public void onStop() { finish("屏幕共享已结束。"); }

        @Override public void onCapturedContentResize(int width, int height) {
            if (stopping || display == null) return;
            try { resize(width, height); }
            catch (RuntimeException error) { finish("屏幕尺寸变化后无法继续投屏，请重新开始。"); }
        }
    };

    private void begin(Size bounds) {
        if (stopping) return;
        try {
            token = SecureTokenPlugin.readStoredValue(this, "codex.remote.pairing-token");
            if (token == null || token.isBlank()) throw new SessionEnded("请先完成 Codex Remote 配对。");
            try (Response result = execute("start", RequestBody.create(new byte[0], null))) {
                if (result.code() == 404) throw new SessionEnded("请更新 Windows 配套服务到 0.9.3。");
                if (result.code() == 401) throw new SessionEnded("配对令牌失效，请检查连接设置。");
                if (!result.isSuccessful()) throw new SessionEnded(replyError(result));
                session = new JSONObject(result.peekBody(4096).string()).getString("id");
                if (!session.matches("[a-f0-9-]{36}")) throw new IOException("Invalid session");
            }
            if (stopping) return;
            projection.registerCallback(callback, worker);
            resize(bounds.getWidth(), bounds.getHeight());
            lastSend = android.os.SystemClock.elapsedRealtime();
            worker.post(this::frame);
        } catch (SessionEnded error) {
            finish(error.getMessage());
        } catch (Exception error) {
            finish("无法连接电脑的跨网阅读窗，请检查隧道和电脑状态。");
        }
    }

    private void resize(int width, int height) {
        if (width <= 0 || height <= 0) return;
        float ratio = Math.min(1f, Math.min(520f / Math.min(width, height), 1200f / Math.max(width, height)));
        int w = Math.max(2, Math.round(width * ratio / 2) * 2);
        int h = Math.max(2, Math.round(height * ratio / 2) * 2);
        if (capture != null && capture.getWidth() == w && capture.getHeight() == h) return;

        ImageReader next = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 3);
        try {
            if (display == null) {
                display = projection.createVirtualDisplay("Codex Remote", w, h, density,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, next.getSurface(), null, worker);
                if (display == null) throw new IllegalStateException("No virtual display");
            } else {
                display.resize(w, h, density);
                display.setSurface(next.getSurface());
            }
        } catch (RuntimeException error) {
            next.close();
            throw error;
        }
        if (capture != null) capture.close();
        capture = next;
        lastFrame = null;
    }

    private void frame() {
        if (stopping) return;
        try {
            byte[] jpeg = nextJpeg();
            long now = android.os.SystemClock.elapsedRealtime();
            if (jpeg == null && now - lastSend >= 2000) jpeg = lastFrame;
            if (jpeg != null && (now - lastSend >= 2000 || !Arrays.equals(lastFrame, jpeg))) {
                try (Response response = execute("frame", RequestBody.create(jpeg, JPEG))) {
                    if (response.code() == 410 || response.code() == 401) throw new SessionEnded(replyError(response));
                    if (!response.isSuccessful()) throw new IOException("Frame not accepted");
                }
                lastFrame = jpeg;
                lastSend = now;
                currentState = "sharing";
                currentDetail = "";
            }
            if (now - lastSend > 15_000) throw new SessionEnded("未能采集到画面，请重新共享。");
        } catch (SessionEnded error) {
            finish(error.getMessage());
            return;
        } catch (IOException error) {
            if (android.os.SystemClock.elapsedRealtime() - lastSend > 12_000) {
                finish("投屏连接中断，请检查网络后重试。");
                return;
            }
            currentState = "connecting";
            currentDetail = "正在重试连接…";
        } catch (RuntimeException error) {
            finish("画面采集已中断，请重新开始。");
            return;
        }
        if (!stopping) worker.postDelayed(this::frame, FRAME_INTERVAL);
    }

    private byte[] nextJpeg() {
        try (Image image = capture.acquireLatestImage()) {
            if (image == null) return null;
            Image.Plane plane = image.getPlanes()[0];
            int strideWidth = plane.getRowStride() / plane.getPixelStride();
            int height = image.getHeight();
            if (workspace == null || workspace.getWidth() != strideWidth || workspace.getHeight() != height) {
                if (workspace != null) workspace.recycle();
                workspace = Bitmap.createBitmap(strideWidth, height, Bitmap.Config.ARGB_8888);
            }
            var pixels = plane.getBuffer();
            int fullBytes = workspace.getByteCount();
            if (pixels.remaining() < fullBytes) {
                var padded = java.nio.ByteBuffer.allocate(fullBytes);
                padded.put(pixels);
                padded.rewind();
                pixels = padded;
            }
            workspace.copyPixelsFromBuffer(pixels);
            Bitmap visible = Bitmap.createBitmap(workspace, 0, 0, image.getWidth(), height);
            try (ByteArrayOutputStream out = new ByteArrayOutputStream(48_000)) {
                visible.compress(Bitmap.CompressFormat.JPEG, 65, out);
                if (out.size() > MAX_FRAME_BYTES) {
                    out.reset();
                    visible.compress(Bitmap.CompressFormat.JPEG, 40, out);
                }
                return out.size() <= MAX_FRAME_BYTES ? out.toByteArray() : null;
            } catch (IOException error) {
                throw new IllegalStateException(error);
            } finally {
                if (visible != workspace) visible.recycle();
            }
        }
    }

    private Request request(String action, RequestBody body) {
        Request.Builder result = new Request.Builder().url(address.resolve("/api/reader/" + action))
                .header("Authorization", "Bearer " + token).header("ngrok-skip-browser-warning", "1").post(body);
        if (session != null) result.header("X-CMR-Reader-Session", session);
        return result.build();
    }

    private Response execute(String action, RequestBody body) throws IOException {
        Call call = HTTP.newCall(request(action, body));
        inFlight = call;
        if (stopping) call.cancel();
        return call.execute();
    }

    private String replyError(Response response) {
        try {
            return new JSONObject(response.peekBody(4096).string()).getString("error");
        } catch (Exception error) {
            return "电脑未能确认投屏，请检查跨网阅读窗。";
        }
    }

    private void finish(String message) {
        main.post(() -> {
            if (stopping) return;
            currentDetail = message;
            stopSelf();
        });
    }

    @Override public void onDestroy() {
        stopping = true;
        currentState = "idle";
        if (inFlight != null) inFlight.cancel();
        if (worker != null) {
            worker.removeCallbacksAndMessages(null);
            worker.post(() -> {
                if (display != null) display.release();
                if (capture != null) capture.close();
                if (workspace != null) workspace.recycle();
                if (projection != null) {
                    projection.unregisterCallback(callback);
                    projection.stop();
                }
                if (session != null) {
                    try (Response ignored = HTTP.newCall(request("stop", RequestBody.create(new byte[0], null))).execute()) {}
                    catch (IOException ignored) {}
                }
                thread.quitSafely();
            });
        } else if (projection != null) projection.stop();
        super.onDestroy();
    }

    private static final class SessionEnded extends IOException {
        SessionEnded(String message) { super(message); }
    }
}
