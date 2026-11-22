package dev.codexmobile.remote;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import okhttp3.HttpUrl;

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
                .putExtra("consent", result.getData()).putExtra("address", call.getString("address"));
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
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), CrossNetworkReaderService.class));
        call.resolve();
    }
}
