package dev.codexmobile.remote;

import android.content.ClipData;
import android.content.ClipboardManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeviceClipboard")
public class DeviceClipboardPlugin extends Plugin {
    @PluginMethod
    public void read(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!getActivity().hasWindowFocus()) {
                call.reject("请回到 Codex Remote 后再读取手机剪贴板。");
                return;
            }
            ClipboardManager clipboard = getActivity().getSystemService(ClipboardManager.class);
            ClipData clip = clipboard.getPrimaryClip();
            CharSequence text = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).getText() : null;
            JSObject result = new JSObject();
            result.put("text", text == null ? "" : text.toString());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        String text = call.getString("text");
        if (text == null) {
            call.reject("手机剪贴板需要纯文本。");
            return;
        }
        getActivity().runOnUiThread(() -> {
            ClipboardManager clipboard = getActivity().getSystemService(ClipboardManager.class);
            clipboard.setPrimaryClip(ClipData.newPlainText("Codex Remote", text));
            call.resolve();
        });
    }
}
