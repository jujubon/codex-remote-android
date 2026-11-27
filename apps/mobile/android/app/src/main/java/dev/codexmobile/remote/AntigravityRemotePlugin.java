package dev.codexmobile.remote;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;

@CapacitorPlugin(name = "AntigravityRemote")
public class AntigravityRemotePlugin extends Plugin {
    private static final String CHROME = "com.android.chrome";
    private static final Uri PORTAL = Uri.parse("https://antigravity.google.com/");

    @PluginMethod
    public void open(PluginCall call) {
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            String provider = findBrowser(activity);
            if (provider == null) {
                call.reject("No browser supports Custom Tabs", "no_compatible_browser");
                return;
            }

            CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(true).build();
            tab.intent.setPackage(provider);
            try {
                tab.launchUrl(activity, PORTAL);
                call.resolve();
            } catch (ActivityNotFoundException | SecurityException error) {
                call.reject("Unable to open Antigravity Remote Control", error);
            }
        });
    }

    static String findBrowser(Context context) {
        String chrome = CustomTabsClient.getPackageName(context, Collections.singletonList(CHROME), true);
        return chrome != null ? chrome : CustomTabsClient.getPackageName(context, Collections.emptyList());
    }
}
