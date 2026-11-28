package dev.codexmobile.remote;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

final class CampusMailNotifications {
    private static final String SILENT_CHANNEL = "campus_mail_silent";
    private static final String PRIORITY_CHANNEL = "campus_mail_priority";
    private static final String TITLE = "收到新邮件";
    private static final int NOTIFICATION_ID = 815;
    private static final long MAX_AGE = 24 * 60 * 60 * 1000L;

    private CampusMailNotifications() {}

    static synchronized void publish(Context context, JSONArray alerts) {
        if (alerts == null || alerts.length() == 0 || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(SILENT_CHANNEL, "邮箱", NotificationManager.IMPORTANCE_LOW));
            manager.createNotificationChannel(new NotificationChannel(PRIORITY_CHANNEL, "邮箱 · 重点邮件", NotificationManager.IMPORTANCE_DEFAULT));
        }

        Set<String> active = new HashSet<>();
        for (StatusBarNotification item : manager.getActiveNotifications()) {
            if (item.getId() == NOTIFICATION_ID && item.getTag() != null) active.add(item.getTag());
        }
        SharedPreferences seen = context.getSharedPreferences("campus_mail_seen_v1", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = seen.edit();
        long cutoff = System.currentTimeMillis() - MAX_AGE;
        for (String id : seen.getAll().keySet()) if (Math.abs(seen.getLong(id, 0)) < cutoff - MAX_AGE) editor.remove(id);
        for (int index = 0; index < alerts.length(); index++) {
            JSONObject alert = alerts.optJSONObject(index);
            if (alert == null) continue;
            String id = alert.optString("id");
            String mailId = alert.optString("mailId", id);
            long at = alert.optLong("at");
            if (!id.matches("[a-f0-9]{64}") || !mailId.matches("[a-f0-9]{64}") || at < cutoff) continue;
            boolean posted = seen.contains(id);
            String tag = "campus-mail-" + id;
            // A completed summary can update an existing notification, including after a reconnect.
            // A dismissed notification stays dismissed.
            String preview = alert.optString("preview", "");
            if (posted && (preview.isEmpty() || !active.contains(tag) || seen.getLong(id, 0) < 0)) continue;
            boolean priority = alert.optBoolean("priority");
            String channel = priority ? PRIORITY_CHANNEL : SILENT_CHANNEL;
            Intent open = new Intent(context, MainActivity.class).setAction(Intent.ACTION_MAIN)
                    .setData(Uri.parse("codexremote://mail/" + mailId))
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            NotificationActionStore.decorate(open, "global", "openMail:" + mailId, "mail");
            PendingIntent pending = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification redacted = new NotificationCompat.Builder(context, channel)
                    .setSmallIcon(R.drawable.ic_codex_notification).setContentTitle(TITLE).build();
            NotificationCompat.Builder notification = new NotificationCompat.Builder(context, channel)
                    .setSmallIcon(R.drawable.ic_codex_notification).setContentTitle(alert.optString("subject", TITLE))
                    .setContentText(preview.isEmpty() ? "点击查看邮件" : preview)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(preview.isEmpty() ? "点击查看邮件" : preview))
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(redacted)
                    .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true).setWhen(at)
                    .setSilent(!priority || posted).setPriority(priority ? NotificationCompat.PRIORITY_DEFAULT : NotificationCompat.PRIORITY_LOW);
            if (priority && !posted && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) notification.setDefaults(Notification.DEFAULT_SOUND);
            try {
                manager.notify(tag, NOTIFICATION_ID, notification.build());
                editor.putLong(id, preview.isEmpty() ? at : -at);
            } catch (SecurityException ignored) {
                // Permission may have been revoked since the check.
            }
        }
        editor.apply();
    }
}
