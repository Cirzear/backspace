package io.github.backspace.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "BackspaceSession")
public class BackspaceSessionPlugin extends Plugin {
    private static final String KEY_ALIAS = "backspace.session.aes.v1";
    private static final String SESSION_KEY = "session";
    private static final int MAX_SESSION_BYTES = 1024 * 1024;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_ENCODED_BYTES = 4 * ((MAX_SESSION_BYTES + IV_BYTES + TAG_BITS / 8 + 2) / 3);

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("backspace_session", Context.MODE_PRIVATE);
    }

    // The bridge accepts only bundled content: no server.url, allowNavigation, or navigation overrides.
    // Calls execute synchronously on Capacitor's plugin queue, so read/write/clear preserve call order.
    @PluginMethod
    public void read(PluginCall call) {
        try {
            String stored = preferences().getString(SESSION_KEY, null);
            JSObject result = new JSObject();
            if (stored == null) {
                result.put("value", JSONObject.NULL);
                call.resolve(result);
                return;
            }
            if (stored.length() > MAX_ENCODED_BYTES) {
                throw new GeneralSecurityException("Stored session exceeds size limit");
            }
            byte[] encrypted = Base64.decode(stored, Base64.NO_WRAP);
            if (encrypted.length <= IV_BYTES + TAG_BITS / 8 || encrypted.length > MAX_SESSION_BYTES + IV_BYTES + TAG_BITS / 8) {
                throw new GeneralSecurityException("Invalid stored session length");
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, sessionKey(false), new GCMParameterSpec(TAG_BITS, Arrays.copyOf(encrypted, IV_BYTES)));
            byte[] plain = cipher.doFinal(encrypted, IV_BYTES, encrypted.length - IV_BYTES);
            result.put("value", new String(plain, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            // Corruption or key loss must be visible; never silently erase a user's session.
            call.reject("Unable to read encrypted session", "SESSION_READ_FAILED", error);
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        // Do not coerce numbers/null into strings. JSON schema and federated identities belong to the SPA.
        Object input = call.getData().opt("value");
        if (!(input instanceof String) || ((String) input).isEmpty()) {
            call.reject("value must be a non-empty string", "SESSION_INVALID_VALUE");
            return;
        }
        byte[] plain = ((String) input).getBytes(StandardCharsets.UTF_8);
        if (plain.length > MAX_SESSION_BYTES) {
            call.reject("value must not exceed 1 MiB in UTF-8", "SESSION_TOO_LARGE");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            // Android Keystore generates a fresh random IV; never reuse or supply an encryption IV.
            cipher.init(Cipher.ENCRYPT_MODE, sessionKey(true));
            byte[] iv = cipher.getIV();
            if (iv.length != IV_BYTES) {
                throw new GeneralSecurityException("Unexpected AES-GCM IV length");
            }
            byte[] encrypted = cipher.doFinal(plain);
            byte[] envelope = ByteBuffer.allocate(iv.length + encrypted.length).put(iv).put(encrypted).array();
            String encoded = Base64.encodeToString(envelope, Base64.NO_WRAP);
            // commit(), not apply(): resolving promises is an acknowledgement of durable persistence.
            if (!preferences().edit().putString(SESSION_KEY, encoded).commit()) {
                throw new IllegalStateException("Session persistence commit failed");
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to persist encrypted session", "SESSION_WRITE_FAILED", error);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            if (!preferences().edit().remove(SESSION_KEY).commit()) {
                throw new IllegalStateException("Session deletion commit failed");
            }
            // Retain the non-exportable key; deleting it is not required to delete the session.
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to clear encrypted session", "SESSION_CLEAR_FAILED", error);
        }
    }

    private SecretKey sessionKey(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return (SecretKey) store.getKey(KEY_ALIAS, null);
        }
        if (!create) {
            throw new GeneralSecurityException("Session encryption key is missing");
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
