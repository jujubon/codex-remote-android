package dev.codexmobile.remote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class CompanionUpdateCleanupReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        Context app = context.getApplicationContext();
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                CompanionUpdatePlugin.clearInstalledArchives(app);
            } finally {
                result.finish();
            }
        }, "companion-update-cleanup").start();
    }
}
