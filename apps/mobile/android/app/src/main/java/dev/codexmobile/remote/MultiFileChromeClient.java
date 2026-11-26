package dev.codexmobile.remote;

import android.content.ActivityNotFoundException;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

import java.util.Arrays;

final class MultiFileChromeClient extends BridgeWebChromeClient {
    private final ActivityResultLauncher<String[]> documentPicker;
    private ValueCallback<Uri[]> pendingSelection;

    MultiFileChromeClient(Bridge bridge) {
        super(bridge);
        documentPicker = bridge.registerForActivityResult(new ActivityResultContracts.OpenMultipleDocuments(),
            documents -> finishSelection(documents.isEmpty() ? null : documents.toArray(new Uri[0])));
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (params.getMode() != FileChooserParams.MODE_OPEN_MULTIPLE || params.isCaptureEnabled()) {
            return super.onShowFileChooser(view, callback, params);
        }

        String[] mimeTypes = Arrays.stream(params.getAcceptTypes())
            .filter(type -> type != null && !type.trim().isEmpty()).toArray(String[]::new);
        if (Arrays.stream(mimeTypes).anyMatch(type -> !type.contains("/"))) {
            return super.onShowFileChooser(view, callback, params);
        }

        if (pendingSelection != null) {
            callback.onReceiveValue(null);
            return true;
        }
        pendingSelection = callback;
        try {
            documentPicker.launch(mimeTypes.length == 0 ? new String[] { "*/*" } : mimeTypes);
            return true;
        } catch (ActivityNotFoundException error) {
            pendingSelection = null;
            return super.onShowFileChooser(view, callback, params);
        }
    }

    private void finishSelection(Uri[] documents) {
        ValueCallback<Uri[]> callback = pendingSelection;
        pendingSelection = null;
        if (callback != null) callback.onReceiveValue(documents);
    }
}
