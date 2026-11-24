package dev.codexmobile.remote;

import java.util.Arrays;

final class ReaderFrameBuffer {
    private byte[] latest;
    private byte[] delivered;
    private long lastDelivery;

    ReaderFrameBuffer(long startedAt) {
        lastDelivery = startedAt;
    }

    void capture(byte[] jpeg) {
        latest = jpeg;
    }

    byte[] next(long now, boolean captureReady) {
        if (latest == null) return null;
        if (!Arrays.equals(latest, delivered)) return latest;
        return captureReady && now - lastDelivery >= 2_000 ? latest : null;
    }

    void acknowledge(byte[] jpeg, long now) {
        delivered = jpeg;
        lastDelivery = now;
    }

    long lastDelivery() {
        return lastDelivery;
    }
}
