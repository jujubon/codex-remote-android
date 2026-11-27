package dev.codexmobile.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.robolectric.Shadows.shadowOf;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsService;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowPackageManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class AntigravityRemotePluginTest {
    private static final String CHROME = "com.android.chrome";
    private static final String DEFAULT_BROWSER = "test.default.browser";
    private final Context context = RuntimeEnvironment.getApplication();
    private final ShadowPackageManager packages = shadowOf(context.getPackageManager());

    @Test public void prefersChromeOverTheDefaultBrowser() {
        setDefaultBrowser();
        supportCustomTabs(DEFAULT_BROWSER);
        supportCustomTabs(CHROME);

        assertEquals(CHROME, AntigravityRemotePlugin.findBrowser(context));
    }

    @Test public void usesTheDefaultBrowserWhenItSupportsCustomTabs() {
        setDefaultBrowser();
        supportCustomTabs(DEFAULT_BROWSER);

        assertEquals(DEFAULT_BROWSER, AntigravityRemotePlugin.findBrowser(context));
    }

    @Test public void rejectsAnOrdinaryBrowserHandlerWithoutCustomTabs() {
        setDefaultBrowser();

        assertNull(AntigravityRemotePlugin.findBrowser(context));
    }

    private void setDefaultBrowser() {
        ResolveInfo browser = new ResolveInfo();
        browser.activityInfo = new ActivityInfo();
        browser.activityInfo.packageName = DEFAULT_BROWSER;
        browser.activityInfo.name = DEFAULT_BROWSER + ".BrowserActivity";
        browser.activityInfo.applicationInfo = new ApplicationInfo();
        browser.activityInfo.applicationInfo.packageName = DEFAULT_BROWSER;
        packages.addResolveInfoForIntent(new Intent(Intent.ACTION_VIEW, Uri.parse("http://")), browser);
    }

    private void supportCustomTabs(String packageName) {
        ServiceInfo service = new ServiceInfo();
        service.packageName = packageName;
        service.name = packageName + ".CustomTabsService";
        service.exported = true;
        packages.addOrUpdateService(service);
        packages.addIntentFilterForService(new ComponentName(packageName, service.name),
                new IntentFilter(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION));
    }
}
