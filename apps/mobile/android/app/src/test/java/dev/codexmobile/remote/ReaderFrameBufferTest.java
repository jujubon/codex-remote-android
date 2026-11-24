package dev.codexmobile.remote;

import org.junit.Test;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNull;

public class ReaderFrameBufferTest {
    @Test public void retriesTheFirstFrameWithoutWaitingForScreenChanges() {
        ReaderFrameBuffer buffer = new ReaderFrameBuffer(100);
        byte[] stillImage = { 1, 2 };
        buffer.capture(stillImage);
        assertArrayEquals(stillImage, buffer.next(200, true));
        // The request failed and did not acknowledge the frame.
        assertArrayEquals(stillImage, buffer.next(5_000, true));
        buffer.acknowledge(stillImage, 5_100);
        assertNull(buffer.next(5_500, true));
        assertArrayEquals(stillImage, buffer.next(7_100, true));
    }

    @Test public void sendsTheNewestFrameAndPausesKeepalivesDuringSurfaceRecovery() {
        ReaderFrameBuffer buffer = new ReaderFrameBuffer(0);
        byte[] first = { 1 };
        byte[] second = { 2 };
        buffer.capture(first);
        buffer.acknowledge(first, 100);
        assertNull(buffer.next(5_000, false));
        buffer.capture(second);
        assertArrayEquals(second, buffer.next(5_100, true));
    }
}
