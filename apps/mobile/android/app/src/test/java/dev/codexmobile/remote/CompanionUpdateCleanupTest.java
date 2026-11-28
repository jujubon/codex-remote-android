package dev.codexmobile.remote;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class CompanionUpdateCleanupTest {
    @Rule public TemporaryFolder cache = new TemporaryFolder();

    @Test
    public void removesInstalledAndOlderPackagesButKeepsFutureDownloads() throws Exception {
        File older = cache.newFile("Codex-Remote-1.9.99.apk");
        File installed = cache.newFile("Codex-Remote-1.10.0.apk");
        File future = cache.newFile("Codex-Remote-1.10.1.apk");
        File downloading = cache.newFile("download.part");
        File other = cache.newFile("other.apk");

        CompanionUpdatePlugin.clearInstalledArchives(cache.getRoot(), "1.10.0");

        assertFalse(older.exists());
        assertFalse(installed.exists());
        assertTrue(future.exists());
        assertTrue(downloading.exists());
        assertTrue(other.exists());
    }
}
