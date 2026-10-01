package io.github.backspace.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register before the bridge is built; retain Capacitor's external navigation isolation.
        registerPlugin(BackspaceSessionPlugin.class);
        registerPlugin(BackspaceScreenSharePlugin.class);
        super.onCreate(savedInstanceState);
        // Inset the entire WebView, including fixed portals. CSS padding on individual
        // pages cannot protect fullscreen layouts and would double-count keyboard resize.
        View decor = getWindow().getDecorView();
        new WindowInsetsControllerCompat(getWindow(), decor).setAppearanceLightStatusBars(false);
        new WindowInsetsControllerCompat(getWindow(), decor).setAppearanceLightNavigationBars(false);
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, windowInsets) -> {
            int systemTypes = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets bars = windowInsets.getInsets(systemTypes);
            Insets keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            // The native viewport already excludes these areas; do not expose them
            // again as CSS env() insets or dispatch the IME a second time to WebView.
            return new WindowInsetsCompat.Builder(windowInsets)
                .setInsets(systemTypes | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });
        ViewCompat.requestApplyInsets(decor);
    }
}
