package dev.codexmobile.remote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.KeyguardManager;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.function.Consumer;

public class ReaderGestureService extends AccessibilityService {
    private static volatile ReaderGestureService instance;
    private long lastGesture = -1_000;

    static boolean available() { return instance != null; }

    @Override protected void onServiceConnected() { instance = this; }

    @Override public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {}
    @Override public void onInterrupt() {}

    static void send(String target, String action, Consumer<String> result) {
        ReaderGestureService service = instance;
        if (service == null) {
            result.accept("unavailable");
            return;
        }
        service.swipe(target, action, result);
    }

    private Rect readingBounds(String target) {
        if (getSystemService(KeyguardManager.class).isKeyguardLocked()) return null;
        for (AccessibilityWindowInfo window : getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return null;
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null || !target.contentEquals(root.getPackageName())) return null;
        AccessibilityWindowInfo window = root.getWindow();
        if (window == null || !window.isActive() || window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION ||
                (Build.VERSION.SDK_INT >= 26 && window.isInPictureInPictureMode())) return null;
        Rect bounds = new Rect();
        window.getBoundsInScreen(bounds);
        return bounds.width() < 240 || bounds.height() < 240 ? null : bounds;
    }

    private void swipe(String target, String action, Consumer<String> result) {
        Rect bounds = readingBounds(target);
        if (bounds == null) {
            result.accept("wrong-app");
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (now - lastGesture < 450) {
            result.accept("interrupted");
            return;
        }
        float startX = .5f, endX = .5f, startY = .55f, endY = .55f;
        switch (action) {
            case "next": startX = .78f; endX = .22f; break;
            case "previous": startX = .22f; endX = .78f; break;
            case "scroll-down": startY = .72f; endY = .32f; break;
            case "scroll-up": startY = .32f; endY = .72f; break;
            default: result.accept("interrupted"); return;
        }
        Path path = new Path();
        path.moveTo(bounds.left + startX * bounds.width(), bounds.top + startY * bounds.height());
        path.lineTo(bounds.left + endX * bounds.width(), bounds.top + endY * bounds.height());
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 240)).build();
        lastGesture = now;
        boolean started = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription description) { result.accept("done"); }
            @Override public void onCancelled(GestureDescription description) { result.accept("interrupted"); }
        }, null);
        if (!started) result.accept("interrupted");
    }
}
