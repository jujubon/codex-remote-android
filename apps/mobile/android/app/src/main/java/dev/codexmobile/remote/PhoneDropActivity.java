package dev.codexmobile.remote;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.core.content.IntentCompat;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;
import org.json.JSONObject;

/** Receives ACTION_SEND with a narrow set of types and uploads under the existing pairing. */
public class PhoneDropActivity extends Activity {
    private static final long MAX_FILE_BYTES = 64L * 1024 * 1024;
    private static final Pattern URL = Pattern.compile("https?://[^\\s<>]+", Pattern.CASE_INSENSITIVE);
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(90, TimeUnit.SECONDS)
            .writeTimeout(90, TimeUnit.SECONDS)
            .callTimeout(5, TimeUnit.MINUTES)
            .build();

    private TextView status;
    private Button retry;
    private Button done;
    private Button sendButton;
    private ProgressBar progress;
    private ArrayList<Uri> files;
    private String link;
    private String transferId;
    private volatile int completed;
    private boolean working;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        transferId = state == null ? UUID.randomUUID().toString() : state.getString("transferId", UUID.randomUUID().toString());
        completed = state == null ? 0 : state.getInt("completed");
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int inset = (int) (24 * getResources().getDisplayMetrics().density);
        content.setPadding(inset, inset, inset, inset);
        status = new TextView(this);
        status.setTextSize(16);
        content.addView(status);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        content.addView(progress);
        progress.setVisibility(android.view.View.GONE);
        sendButton = new Button(this);
        sendButton.setText("发送到电脑");
        sendButton.setOnClickListener(view -> send());
        sendButton.setVisibility(android.view.View.GONE);
        content.addView(sendButton);
        retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(view -> send());
        retry.setVisibility(android.view.View.GONE);
        content.addView(retry);
        done = new Button(this);
        done.setText("完成");
        done.setOnClickListener(view -> finish());
        content.addView(done);
        setContentView(content);

        try {
            readShare(getIntent());
            int count = link == null ? files.size() : 1;
            status.setText(link == null ? "将 " + count + " 个文件发送到已配对的电脑。" : "将此链接发送到已配对的电脑：\n" + link);
            if ("1".equals(getSharedPreferences("CapacitorStorage", MODE_PRIVATE)
                    .getString("codex.remote.quick-share", "0"))) send();
            else sendButton.setVisibility(android.view.View.VISIBLE);
        } catch (IOException | RuntimeException error) {
            status.setText(error instanceof IOException ? error.getMessage() : "无法读取分享内容。");
            progress.setVisibility(android.view.View.GONE);
            retry.setVisibility(android.view.View.GONE);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        state.putString("transferId", transferId);
        state.putInt("completed", completed);
        super.onSaveInstanceState(state);
    }

    private void readShare(Intent intent) throws IOException {
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            throw new IOException("请从其他 App 的分享菜单选择「发送到电脑」。");
        }
        files = Intent.ACTION_SEND_MULTIPLE.equals(action)
                ? IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class) : new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri file = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (file != null) files.add(file);
        }
        if (files == null) files = new ArrayList<>();
        ClipData clipped = intent.getClipData();
        if (files.isEmpty() && clipped != null) {
            for (int i = 0; i < clipped.getItemCount(); i++) {
                Uri uri = clipped.getItemAt(i).getUri();
                if (uri != null) files.add(uri);
            }
        }
        if (!files.isEmpty()) {
            if (files.size() > 20) throw new IOException("一次最多发送 20 个文件。");
            for (Uri file : files) {
                if (file == null || !"content".equals(file.getScheme())
                        || (getPackageName() + ".fileprovider").equals(file.getAuthority()))
                    throw new IOException("分享来源未提供可读取的文件。");
            }
            return;
        }
        files = new ArrayList<>();
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        Matcher matcher = URL.matcher(text == null ? "" : text);
        if (!matcher.find()) throw new IOException("当前支持分享图片、PDF 或网页链接。");
        link = matcher.group();
        if (link.length() > 8000) throw new IOException("网页链接过长。");
    }

    private void send() {
        if (working) return;
        working = true;
        int count = link == null ? files.size() : 1;
        progress.setVisibility(android.view.View.VISIBLE);
        sendButton.setVisibility(android.view.View.GONE);
        retry.setVisibility(android.view.View.GONE);
        done.setVisibility(android.view.View.GONE);
        status.setText("正在发送到电脑…");
        new Thread(() -> {
            try {
                String base = getSharedPreferences("CapacitorStorage", MODE_PRIVATE)
                        .getString("codex.remote.server-url", "");
                String token = SecureTokenPlugin.readStoredValue(this, "codex.remote.pairing-token");
                if (base == null || base.isEmpty() || token == null || token.isEmpty())
                    throw new IOException("请先在 Codex Remote 中配对电脑，再重试。");
                if (base.startsWith("wss://")) base = "https://" + base.substring(6);
                if (base.startsWith("ws://")) base = "http://" + base.substring(5);
                HttpUrl host = HttpUrl.get(base);
                if (!host.username().isEmpty() || !host.password().isEmpty())
                    throw new IOException("请检查 Codex Remote 的服务器地址。");
                while (completed < count) {
                    int index = completed;
                    runOnUiThread(() -> status.setText("正在发送 " + (index + 1) + " / " + count));
                    Request.Builder request = new Request.Builder().header("Authorization", "Bearer " + token)
                            .header("ngrok-skip-browser-warning", "1");
                    String id = transferId + "_" + index;
                    if (link != null) {
                        String json = new JSONObject().put("requestId", id).put("url", link).toString();
                        request.url(host.resolve("/api/device/share/link"))
                                .post(RequestBody.create(json, MediaType.get("application/json")));
                    } else {
                        Uri uri = files.get(index);
                        String name = URLEncoder.encode(fileName(uri), StandardCharsets.UTF_8.name());
                        request.url(host.resolve("/api/device/share/file"))
                                .header("X-CMR-Filename", name.replace("+", "%20"))
                                .header("X-CMR-Request-Id", id)
                                .post(fileBody(uri));
                    }
                    try (Response result = CLIENT.newCall(request.build()).execute()) {
                        if (result.code() == 404) throw new IOException("需要更新 Windows 配套服务。");
                        if (result.code() == 401) throw new IOException("配对令牌失效，请检查连接设置。");
                        if (result.code() == 502 || result.code() == 503)
                            throw new IOException("电脑暂时离线，请检查 Windows 服务和隧道。");
                        if (result.code() == 413) throw new IOException("单个文件不能超过 64 MB。");
                        JSONObject json = new JSONObject(result.peekBody(16 * 1024).string());
                        if (!result.isSuccessful() || !json.has("fileName"))
                            throw new IOException(json.optString("error", "电脑未确认收到文件。"));
                    }
                    completed++;
                }
                runOnUiThread(() -> setResultMessage("电脑已收到 " + count + " 项。", false));
            } catch (Exception error) {
                String text = error instanceof IOException && !(error instanceof java.net.SocketException)
                        && !(error instanceof java.io.InterruptedIOException) ? error.getMessage() : null;
                runOnUiThread(() -> setResultMessage(
                        "已送达 " + completed + " / " + count + "。"
                                + (text == null ? "未能完成传输，请检查连接后重试。" : text), true));
            }
        }, "codex-phone-drop").start();
    }

    private void setResultMessage(String message, boolean canRetry) {
        working = false;
        if (isFinishing() || isDestroyed()) return;
        status.setText(message);
        progress.setVisibility(android.view.View.GONE);
        retry.setVisibility(canRetry ? android.view.View.VISIBLE : android.view.View.GONE);
        done.setVisibility(android.view.View.VISIBLE);
    }

    private String fileName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && cursor.getColumnCount() > 0) {
                String value = cursor.getString(0);
                if (value != null && !value.isEmpty()) return value.substring(0, Math.min(value.length(), 240));
            }
        } catch (RuntimeException ignored) { }
        return "来自手机的文件";
    }

    private RequestBody fileBody(Uri uri) {
        ContentResolver resolver = getContentResolver();
        String type = resolver.getType(uri);
        MediaType mediaType = MediaType.parse(type == null ? "application/octet-stream" : type);
        return new RequestBody() {
            @Override public MediaType contentType() { return mediaType; }

            @Override public void writeTo(BufferedSink sink) throws IOException {
                try (InputStream input = resolver.openInputStream(uri)) {
                    if (input == null) throw new IOException("无法读取分享的文件。");
                    byte[] buffer = new byte[32 * 1024];
                    long total = 0;
                    int length;
                    while ((length = input.read(buffer)) != -1) {
                        total += length;
                        if (total > MAX_FILE_BYTES) throw new IOException("单个文件不能超过 64 MB。");
                        sink.write(buffer, 0, length);
                    }
                }
            }
        };
    }
}
