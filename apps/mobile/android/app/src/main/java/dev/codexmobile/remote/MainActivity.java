package dev.codexmobile.remote;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureTokenPlugin.class);
        registerPlugin(CodexBackgroundPlugin.class);
        registerPlugin(CodexFileTransferPlugin.class);
        registerPlugin(DeviceClipboardPlugin.class);
        registerPlugin(LanDiscoveryPlugin.class);
        registerPlugin(CrossNetworkReaderPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setWebChromeClient(new MultiFileChromeClient(getBridge()));
    }
}
