package com.cosmaneura.capture.securequeue;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "SecureQueue")
public final class SecureQueuePlugin extends Plugin {
    private final ExecutorService operationExecutor = Executors.newSingleThreadExecutor();
    private SecureQueueStore store;

    @Override
    public void load() {
        store = new SecureQueueStore(getContext());
    }

    @PluginMethod
    public void put(PluginCall call) {
        String key = call.getString("key");
        String encoded = call.getString("data");
        final byte[] data;
        try {
            data = decodeBase64(encoded);
        } catch (SecureQueueException exception) {
            reject(call, exception);
            return;
        }
        perform(call, queue -> {
            JSObject result = new JSObject();
            result.put("revision", Long.toString(queue.put(key, data)));
            return result;
        });
    }

    @PluginMethod
    public void create(PluginCall call) {
        String key = call.getString("key");
        String encoded = call.getString("data");
        final byte[] data;
        try {
            data = decodeBase64(encoded);
        } catch (SecureQueueException exception) {
            reject(call, exception);
            return;
        }
        perform(call, queue -> {
            JSObject result = new JSObject();
            result.put("revision", Long.toString(queue.create(key, data)));
            return result;
        });
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        perform(call, queue -> {
            SecureQueueRecordCodec.Record record = queue.get(key);
            JSObject result = new JSObject();
            result.put("key", record.key());
            result.put("data", Base64.encodeToString(record.data(), Base64.NO_WRAP));
            result.put("revision", Long.toString(record.revision()));
            return result;
        });
    }

    @PluginMethod
    public void list(PluginCall call) {
        perform(call, queue -> {
            JSArray keys = new JSArray();
            for (String key : queue.list()) {
                keys.put(key);
            }
            JSObject result = new JSObject();
            result.put("keys", keys);
            return result;
        });
    }

    @PluginMethod
    public void compareAndSwap(PluginCall call) {
        String key = call.getString("key");
        String encoded = call.getString("data");
        final byte[] data;
        final long expectedRevision;
        try {
            data = decodeBase64(encoded);
            expectedRevision = parseRevision(call.getString("expectedRevision"));
        } catch (SecureQueueException exception) {
            reject(call, exception);
            return;
        }
        perform(call, queue -> {
            JSObject result = new JSObject();
            result.put(
                "revision",
                Long.toString(queue.compareAndSwap(key, expectedRevision, data))
            );
            return result;
        });
    }

    @PluginMethod
    public void delete(PluginCall call) {
        String key = call.getString("key");
        perform(call, queue -> {
            JSObject result = new JSObject();
            result.put("deleted", queue.delete(key));
            return result;
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        perform(call, queue -> {
            JSObject result = new JSObject();
            result.put("cleared", queue.clear());
            return result;
        });
    }

    @Override
    protected void handleOnDestroy() {
        operationExecutor.shutdown();
        super.handleOnDestroy();
    }

    private void perform(PluginCall call, Operation operation) {
        operationExecutor.execute(() -> {
            if (store == null) {
                reject(call, new SecureQueueException(SecureQueueException.Kind.KEY_UNAVAILABLE));
                return;
            }
            try {
                JSObject result = operation.run(store);
                if (result == null) {
                    call.resolve();
                } else {
                    call.resolve(result);
                }
            } catch (SecureQueueException exception) {
                reject(call, exception);
            } catch (RuntimeException exception) {
                reject(call, new SecureQueueException(SecureQueueException.Kind.IO));
            }
        });
    }

    private static byte[] decodeBase64(String encoded) throws SecureQueueException {
        if (encoded == null || encoded.length() % 4 != 0 || !hasCanonicalBase64Characters(encoded)) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        final byte[] decoded;
        try {
            decoded = Base64.decode(encoded, Base64.NO_WRAP);
        } catch (IllegalArgumentException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        if (!Base64.encodeToString(decoded, Base64.NO_WRAP).equals(encoded)) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        return decoded;
    }

    private static long parseRevision(String encoded) throws SecureQueueException {
        if (encoded == null || encoded.isEmpty()) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        final long revision;
        try {
            revision = Long.parseLong(encoded);
        } catch (NumberFormatException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        if (revision <= 0 || !Long.toString(revision).equals(encoded)) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        return revision;
    }

    private static boolean hasCanonicalBase64Characters(String value) {
        int firstPadding = value.indexOf('=');
        int contentEnd = firstPadding == -1 ? value.length() : firstPadding;
        for (int index = 0; index < contentEnd; index += 1) {
            char character = value.charAt(index);
            boolean valid =
                (character >= 'A' && character <= 'Z') ||
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') ||
                character == '+' ||
                character == '/';
            if (!valid) {
                return false;
            }
        }
        int paddingLength = value.length() - contentEnd;
        if (paddingLength > 2) {
            return false;
        }
        for (int index = contentEnd; index < value.length(); index += 1) {
            if (value.charAt(index) != '=') {
                return false;
            }
        }
        return true;
    }

    private static void reject(PluginCall call, SecureQueueException exception) {
        call.reject(exception.publicMessage(), exception.code());
    }

    @FunctionalInterface
    private interface Operation {
        JSObject run(SecureQueueStore queue) throws SecureQueueException;
    }
}
