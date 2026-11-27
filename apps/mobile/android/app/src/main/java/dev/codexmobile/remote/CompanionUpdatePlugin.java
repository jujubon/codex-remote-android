package dev.codexmobile.remote;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "CompanionUpdate")
public class CompanionUpdatePlugin extends Plugin {
    private static final String RELEASE = "https://github.com/jujubon/codex-remote-android/releases/download/";
    private static final long MAX_BYTES = 100L * 1024 * 1024;
    private final AtomicBoolean updating = new AtomicBoolean();

    @PluginMethod
    public void install(PluginCall call) {
        String version = call.getString("version", "");
        String sha = call.getString("sha256", "");
        if (!version.matches("\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}") || !sha.matches("[0-9a-f]{64}")) {
            call.reject("发布包缺少有效的校验值。");
            return;
        }
        if (!updating.compareAndSet(false, true)) {
            call.reject("手机更新正在处理，请稍候。");
            return;
        }
        new Thread(() -> {
            File folder = new File(getContext().getCacheDir(), "companion-update");
            File apk = new File(folder, "Codex-Remote-" + version + ".apk");
            File part = new File(folder, "download.part");
            try {
                if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("无法创建更新缓存。");
                if (!apk.isFile() || apk.length() > MAX_BYTES || !sha.equals(fileDigest(apk))) {
                    download(new URL(RELEASE + "v" + version + "/" + apk.getName()), part);
                    if (!sha.equals(fileDigest(part))) throw new IOException("APK 校验失败，请重试。");
                    if (!part.renameTo(apk)) throw new IOException("无法保存已下载的 APK。");
                }
                android.content.pm.PackageInfo info = getContext().getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
                if (info == null || !getContext().getPackageName().equals(info.packageName) || !version.equals(info.versionName)) {
                    apk.delete();
                    throw new IOException("APK 的应用标识或版本不匹配。");
                }
                File[] cached = folder.listFiles();
                if (cached != null) for (File file : cached) {
                    if (!apk.equals(file) && file.getName().endsWith(".apk")) file.delete();
                }
                getActivity().runOnUiThread(() -> openInstaller(call, apk));
            } catch (Exception error) {
                updating.set(false);
                call.reject(error instanceof IOException && error.getMessage() != null && error.getMessage().endsWith("。")
                    ? error.getMessage() : "无法下载手机更新，请检查网络后重试。");
            } finally {
                part.delete();
            }
        }, "companion-update").start();
    }

    private void openInstaller(PluginCall call, File apk) {
        try {
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())));
                call.resolve(new JSObject().put("state", "permission"));
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(install);
            call.resolve(new JSObject().put("state", "installer"));
        } catch (RuntimeException error) {
            call.reject("无法打开 Android 安装界面，请从发布页下载安装。");
        } finally {
            updating.set(false);
        }
    }

    private static void download(URL url, File destination) throws IOException {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MINUTES.toNanos(4);
        for (int redirects = 0; redirects < 4; redirects++) {
            String host = url.getHost().toLowerCase(Locale.ROOT);
            if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null ||
                (url.getPort() != -1 && url.getPort() != 443) ||
                !("github.com".equals(host) || "release-assets.githubusercontent.com".equals(host) ||
                  "objects.githubusercontent.com".equals(host))) throw new IOException("更新下载地址无效。");
            HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(20000);
            try {
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("更新下载地址无效。");
                    url = new URL(url, location);
                    continue;
                }
                if (status != 200 || connection.getContentLengthLong() > MAX_BYTES) throw new IOException("更新包下载失败。");
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(destination)) {
                    byte[] buffer = new byte[65536];
                    long size = 0;
                    int length;
                    while ((length = input.read(buffer)) != -1) {
                        size += length;
                        if (size > MAX_BYTES || System.nanoTime() > deadline) throw new IOException("更新包下载超时或超过大小限制。");
                        output.write(buffer, 0, length);
                    }
                }
                return;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("更新下载地址无效。");
    }

    private static String fileDigest(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            int length;
            while ((length = input.read(buffer)) != -1) digest.update(buffer, 0, length);
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }
}
