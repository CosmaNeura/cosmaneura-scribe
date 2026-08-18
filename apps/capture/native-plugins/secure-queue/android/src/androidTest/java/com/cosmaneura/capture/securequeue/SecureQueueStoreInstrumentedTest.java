package com.cosmaneura.capture.securequeue;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.Key;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

@RunWith(AndroidJUnit4.class)
public final class SecureQueueStoreInstrumentedTest {
    private File directory;
    private String keyAlias;
    private SecureQueueStore store;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        directory = new File(
            context.getNoBackupFilesDir(),
            "secure-queue-tests/" + UUID.randomUUID()
        );
        keyAlias = "com.cosmaneura.capture.secure-queue.tests." + UUID.randomUUID();
        store = new SecureQueueStore(directory, keyAlias);
    }

    @After
    public void tearDown() throws Exception {
        deleteTree(directory);
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(keyAlias)) {
            keyStore.deleteEntry(keyAlias);
        }
    }

    @Test
    public void roundTripsReplacesListsAndPurgesRecords() throws Exception {
        assertEquals(1, store.create("record-b", new byte[] {0x01, 0x02}));
        assertEquals(1, store.put("record-a", new byte[] {0x03}));
        assertEquals(Arrays.asList("record-a", "record-b"), store.list());
        assertArrayEquals(new byte[] {0x01, 0x02}, store.get("record-b").data());

        SecureQueueException alreadyExists = assertThrows(
            SecureQueueException.class,
            () -> store.create("record-b", new byte[] {0x04})
        );
        assertEquals(SecureQueueException.Kind.ALREADY_EXISTS, alreadyExists.kind());
        SecureQueueException conflict = assertThrows(
            SecureQueueException.class,
            () -> store.compareAndSwap("record-b", 9, new byte[] {0x04})
        );
        assertEquals(SecureQueueException.Kind.REVISION_CONFLICT, conflict.kind());
        assertEquals(2, store.compareAndSwap("record-b", 1, new byte[] {0x04}));
        assertArrayEquals(new byte[] {0x04}, store.get("record-b").data());
        assertEquals(2, store.get("record-b").revision());
        assertTrue(store.delete("record-a"));
        assertFalse(store.delete("record-a"));
        assertEquals(1, store.clear());
        assertEquals(Collections.emptyList(), store.list());
    }

    @Test
    public void ciphertextHidesContentAndRejectsTampering() throws Exception {
        byte[] record = "opaque-test-record".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        store.put("opaque-test-key", record);
        File[] files = directory.listFiles((ignored, name) -> name.endsWith(".sq"));
        assertEquals(1, files == null ? 0 : files.length);
        File file = files[0];
        byte[] envelope = read(file);
        assertFalse(contains(envelope, record));
        assertFalse(
            contains(
                envelope,
                "opaque-test-key".getBytes(java.nio.charset.StandardCharsets.UTF_8)
            )
        );

        envelope[envelope.length - 1] ^= 0x01;
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(envelope);
        }
        SecureQueueException exception = assertThrows(
            SecureQueueException.class,
            () -> store.get("opaque-test-key")
        );
        assertEquals(SecureQueueException.Kind.CORRUPT, exception.kind());
    }

    @Test
    public void keyIsNonExportableAndDirectoryIsUnderNoBackupStorage() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        store.put("record", new byte[0]);
        assertTrue(directory.getCanonicalPath().startsWith(
            context.getNoBackupFilesDir().getCanonicalPath() + File.separator
        ));

        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        Key key = keyStore.getKey(keyAlias, null);
        assertTrue(key.getClass().getName().contains("AndroidKeyStore"));
        assertNull(key.getEncoded());
    }

    private static byte[] read(File file) throws Exception {
        try (InputStream input = new FileInputStream(file);
            ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private static boolean contains(byte[] haystack, byte[] needle) {
        if (needle.length == 0 || needle.length > haystack.length) {
            return false;
        }
        outer:
        for (int start = 0; start <= haystack.length - needle.length; start += 1) {
            for (int offset = 0; offset < needle.length; offset += 1) {
                if (haystack[start + offset] != needle[offset]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteTree(child);
            }
        }
        file.delete();
    }
}
