package dev.codexmobile.remote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.KeyguardManager;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.SystemClock;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;
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

    private void swipe(String target, String action, Consumer<String> result) {
        if (getSystemService(KeyguardManager.class).isKeyguardLocked()) {
            result.accept("locked");
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
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null) {
            result.accept("window-unavailable");
            return;
        }
        if (!target.contentEquals(root.getPackageName())) {
            result.accept("wrong-app");
            return;
        }
        List<AccessibilityWindowInfo> windows = getWindows();
        AccessibilityWindowInfo reading = root.getWindow();
        if (reading == null) {
            for (AccessibilityWindowInfo window : windows) {
                if (window.getId() == root.getWindowId()) {
                    reading = window;
                    break;
                }
            }
        }
        if (reading == null || (!reading.isActive() && !reading.isFocused())
                || reading.getType() != AccessibilityWindowInfo.TYPE_APPLICATION
                || (Build.VERSION.SDK_INT >= 26 && reading.isInPictureInPictureMode())
                || !onPrimaryDisplay(reading)) {
            result.accept("window-unavailable");
            return;
        }
        Rect bounds = new Rect();
        reading.getBoundsInScreen(bounds);
        if (bounds.width() < 240 || bounds.height() < 240) {
            result.accept("window-unavailable");
            return;
        }
        float fromX = bounds.left + startX * bounds.width();
        float fromY = bounds.top + startY * bounds.height();
        float toX = bounds.left + endX * bounds.width();
        float toY = bounds.top + endY * bounds.height();
        Rect strokeBounds = new Rect((int) Math.min(fromX, toX), (int) Math.min(fromY, toY),
                (int) Math.max(fromX, toX) + 1, (int) Math.max(fromY, toY) + 1);
        for (AccessibilityWindowInfo window : windows) {
            if (window.getLayer() <= reading.getLayer() || !onPrimaryDisplay(window)) continue;
            Rect overlay = new Rect();
            window.getBoundsInScreen(overlay);
            if (Rect.intersects(strokeBounds, overlay)) {
                result.accept(window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD ? "keyboard" : "window-unavailable");
                return;
            }
        }
        if (getSystemService(KeyguardManager.class).isKeyguardLocked()) {
            result.accept("locked");
            return;
        }
        Path path = new Path();
        path.moveTo(fromX, fromY);
        path.lineTo(toX, toY);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 240)).build();
        lastGesture = now;
        boolean started = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription description) { result.accept("done"); }
            @Override public void onCancelled(GestureDescription description) { result.accept("interrupted"); }
        }, null);
        if (!started) result.accept("interrupted");
    }

    private static boolean onPrimaryDisplay(AccessibilityWindowInfo window) {
        return Build.VERSION.SDK_INT < 30 || window.getDisplayId() == Display.DEFAULT_DISPLAY;
    }
}
