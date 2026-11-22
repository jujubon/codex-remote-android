package dev.codexmobile.remote;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import okhttp3.HttpUrl;

import java.util.LinkedHashMap;
import java.util.Map;

@CapacitorPlugin(name = "CrossNetworkReader")
public class CrossNetworkReaderPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        String address = call.getString("address");
        HttpUrl url = address == null ? null : HttpUrl.parse(address);
        if (url == null || !url.isHttps() || !url.username().isEmpty() || !url.password().isEmpty()) {
            call.reject("跨网投屏需要 HTTPS 隧道地址。");
            return;
        }
        if (CrossNetworkReaderService.active()) {
            call.reject("屏幕共享已经开始。");
            return;
        }
        String target = call.getString("target");
        if (target != null && (!ReaderGestureService.available() || !readingApps().containsKey(target))) {
            call.reject("请先开启阅读窗翻页权限并选择一个阅读 App。");
            return;
        }
        MediaProjectionManager manager = getContext().getSystemService(MediaProjectionManager.class);
        try {
            startActivityForResult(call, manager.createScreenCaptureIntent(), "onConsent");
        } catch (RuntimeException error) {
            call.reject("无法打开 Android 屏幕共享授权。");
        }
    }

    @ActivityCallback
    private void onConsent(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("已取消屏幕共享。");
            return;
        }
        Intent intent = new Intent(getContext(), CrossNetworkReaderService.class)
                .putExtra("consent", result.getData()).putExtra("address", call.getString("address"))
                .putExtra("target", call.getString("target"));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Android 未允许启动屏幕共享服务。");
        }
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject result = new JSObject();
        result.put("state", CrossNetworkReaderService.state());
        result.put("detail", CrossNetworkReaderService.detail());
        result.put("controlAvailable", ReaderGestureService.available());
        call.resolve(result);
    }

    @PluginMethod
    public void readingTargets(PluginCall call) {
        JSArray apps = new JSArray();
        readingApps().entrySet().stream().sorted(Map.Entry.comparingByValue(java.text.Collator.getInstance()))
                .forEach(app -> {
                    JSObject option = new JSObject();
                    option.put("id", app.getKey());
                    option.put("name", app.getValue());
                    apps.put(option);
                });
        JSObject result = new JSObject();
        result.put("apps", apps);
        call.resolve(result);
    }

    @PluginMethod
    public void openControlSettings(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("请在手机设置中打开「无障碍」，启用「Codex Remote 阅读窗翻页」。");
        }
    }

    private Map<String, String> readingApps() {
        var manager = getContext().getPackageManager();
        Map<String, String> apps = new LinkedHashMap<>();
        var launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for (var activity : manager.queryIntentActivities(launcher, 0)) {
            String id = activity.activityInfo.packageName;
            if (!id.equals(getContext().getPackageName())) apps.putIfAbsent(id, activity.loadLabel(manager).toString());
        }
        return apps;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), CrossNetworkReaderService.class));
        call.resolve();
    }
}
