package dev.codexmobile.remote;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.TextView;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class PhoneDropActivityTest {
    private String textFor(PhoneDropActivity activity, String value) {
        ArrayList<View> matches = new ArrayList<>();
        activity.getWindow().getDecorView().findViewsWithText(matches, value, View.FIND_VIEWS_WITH_TEXT);
        assertTrue("Missing visible text: " + value, !matches.isEmpty());
        return ((TextView) matches.get(0)).getText().toString();
    }

    @Test public void acceptsBrowserLinkFromAndroidShareSheet() {
        Intent share = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "An article https://example.com/article");
        try (var controller = Robolectric.buildActivity(PhoneDropActivity.class, share).setup()) {
            var activity = controller.get();
            assertNotNull(textFor(activity, "https://example.com/article"));
            assertNotNull(textFor(activity, "发送到电脑"));
        }
    }

    @Test public void acceptsReadableContentUriButRejectsFileUris() {
        Intent pdf = new Intent(Intent.ACTION_SEND).setType("application/pdf")
                .putExtra(Intent.EXTRA_STREAM, Uri.parse("content://test.fixture/document/1"))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try (var controller = Robolectric.buildActivity(PhoneDropActivity.class, pdf).setup()) {
            assertNotNull(textFor(controller.get(), "将 1 个文件发送到已配对的电脑。"));
        }
        pdf.putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///private.pdf"));
        try (var controller = Robolectric.buildActivity(PhoneDropActivity.class, pdf).setup()) {
            assertNotNull(textFor(controller.get(), "分享来源未提供可读取的文件。"));
        }
    }
}
