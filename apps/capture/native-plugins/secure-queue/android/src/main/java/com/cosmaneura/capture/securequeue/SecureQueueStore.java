package com.cosmaneura.capture.securequeue;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureQueueStore {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String CIPHER_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String PRODUCTION_KEY_ALIAS =
        "com.cosmaneura.capture.secure-queue.storage-key.v1";
    private static final byte[] ENVELOPE_MAGIC = new byte[] {0x43, 0x53, 0x51, 0x31}; // CSQ1
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final File directory;
    private final String keyAlias;

    SecureQueueStore(Context context) {
        this(
            new File(context.getNoBackupFilesDir(), "CosmaneuraSecureQueue/v1"),
            PRODUCTION_KEY_ALIAS
        );
    }

    SecureQueueStore(File directory, String keyAlias) {
        this.directory = directory;
        this.keyAlias = keyAlias;
    }

    synchronized long put(String recordKey, byte[] data) throws SecureQueueException {
        byte[] digest = SecureQueueRecordCodec.digestForKey(recordKey);
        ensureDirectory();
        AtomicFile atomicFile = new AtomicFile(recordFile(digest));
        SecretKey storageKey;
        long revision;
        if (committedFileExists(atomicFile.getBaseFile())) {
            storageKey = loadStorageKey(false);
            SecureQueueRecordCodec.Record current = open(read(atomicFile), digest, storageKey);
            if (!current.key().equals(recordKey)) {
                throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
            }
            revision = nextRevision(current.revision());
        } else {
            storageKey = loadStorageKey(!hasCommittedRecords());
            revision = 1;
        }
        writeRecord(recordKey, data, revision, digest, storageKey);
        return revision;
    }

    synchronized long create(String recordKey, byte[] data) throws SecureQueueException {
        byte[] digest = SecureQueueRecordCodec.digestForKey(recordKey);
        ensureDirectory();
        AtomicFile atomicFile = new AtomicFile(recordFile(digest));
        if (committedFileExists(atomicFile.getBaseFile())) {
            throw new SecureQueueException(SecureQueueException.Kind.ALREADY_EXISTS);
        }
        SecretKey storageKey = loadStorageKey(!hasCommittedRecords());
        writeRecord(recordKey, data, 1, digest, storageKey);
        return 1;
    }

    synchronized long compareAndSwap(
        String recordKey,
        long expectedRevision,
        byte[] data
    ) throws SecureQueueException {
        if (expectedRevision <= 0) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        byte[] digest = SecureQueueRecordCodec.digestForKey(recordKey);
        AtomicFile atomicFile = new AtomicFile(recordFile(digest));
        if (!committedFileExists(atomicFile.getBaseFile())) {
            throw new SecureQueueException(SecureQueueException.Kind.NOT_FOUND);
        }
        SecretKey storageKey = loadStorageKey(false);
        SecureQueueRecordCodec.Record current = open(read(atomicFile), digest, storageKey);
        if (!current.key().equals(recordKey)) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        if (current.revision() != expectedRevision) {
            throw new SecureQueueException(SecureQueueException.Kind.REVISION_CONFLICT);
        }
        long revision = nextRevision(current.revision());
        writeRecord(recordKey, data, revision, digest, storageKey);
        return revision;
    }

    private void writeRecord(
        String recordKey,
        byte[] data,
        long revision,
        byte[] digest,
        SecretKey storageKey
    ) throws SecureQueueException {
        byte[] plaintext = SecureQueueRecordCodec.encode(recordKey, data, revision);
        final byte[] nonce;
        final byte[] ciphertext;
        try {
            Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
            // AndroidKeyStore rejects caller-supplied IVs when randomized encryption is required.
            // The provider must generate the nonce; only decryption supplies the stored value.
            cipher.init(Cipher.ENCRYPT_MODE, storageKey);
            nonce = cipher.getIV();
            if (nonce == null || nonce.length != NONCE_BYTES) {
                throw new GeneralSecurityException("invalid provider nonce");
            }
            cipher.updateAAD(authenticatedData(digest));
            ciphertext = cipher.doFinal(plaintext);
        } catch (GeneralSecurityException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.KEY_UNAVAILABLE);
        }
        ByteBuffer envelope = ByteBuffer.allocate(ENVELOPE_MAGIC.length + nonce.length + ciphertext.length)
            .put(ENVELOPE_MAGIC)
            .put(nonce)
            .put(ciphertext);
        AtomicFile atomicFile = new AtomicFile(recordFile(digest));
        FileOutputStream output = null;
        try {
            output = atomicFile.startWrite();
            output.write(envelope.array());
            atomicFile.finishWrite(output);
        } catch (IOException exception) {
            if (output != null) {
                atomicFile.failWrite(output);
            }
            throw new SecureQueueException(SecureQueueException.Kind.IO);
        }
    }

    synchronized SecureQueueRecordCodec.Record get(String recordKey) throws SecureQueueException {
        byte[] digest = SecureQueueRecordCodec.digestForKey(recordKey);
        AtomicFile atomicFile = new AtomicFile(recordFile(digest));
        if (!committedFileExists(atomicFile.getBaseFile())) {
            throw new SecureQueueException(SecureQueueException.Kind.NOT_FOUND);
        }
        SecretKey storageKey = loadStorageKey(false);
        SecureQueueRecordCodec.Record record = open(read(atomicFile), digest, storageKey);
        if (!record.key().equals(recordKey)) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        return record;
    }

    synchronized List<String> list() throws SecureQueueException {
        ensureDirectory();
        File[] files = directory.listFiles();
        if (files == null) {
            throw new SecureQueueException(SecureQueueException.Kind.IO);
        }
        Set<String> baseNames = new HashSet<>();
        for (File file : files) {
            String name = file.getName();
            if (name.endsWith(".sq")) {
                baseNames.add(name);
            } else if (name.endsWith(".sq.bak")) {
                baseNames.add(name.substring(0, name.length() - 4));
            }
        }
        if (baseNames.isEmpty()) {
            return Collections.emptyList();
        }
        SecretKey storageKey = loadStorageKey(false);
        List<String> keys = new ArrayList<>(baseNames.size());
        List<String> sortedBaseNames = new ArrayList<>(baseNames);
        Collections.sort(sortedBaseNames);
        for (String baseName : sortedBaseNames) {
            byte[] digest = SecureQueueRecordCodec.digestFromFilename(baseName);
            AtomicFile atomicFile = new AtomicFile(new File(directory, baseName));
            SecureQueueRecordCodec.Record record = open(read(atomicFile), digest, storageKey);
            if (!MessageDigest.isEqual(digest, SecureQueueRecordCodec.digestForKey(record.key()))) {
                throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
            }
            keys.add(record.key());
        }
        Collections.sort(keys);
        return keys;
    }

    synchronized boolean delete(String recordKey) throws SecureQueueException {
        byte[] digest = SecureQueueRecordCodec.digestForKey(recordKey);
        AtomicFile atomicFile = new AtomicFile(recordFile(digest));
        boolean existed = committedFileExists(atomicFile.getBaseFile());
        atomicFile.delete();
        return existed;
    }

    synchronized int clear() throws SecureQueueException {
        ensureDirectory();
        File[] files = directory.listFiles();
        if (files == null) {
            throw new SecureQueueException(SecureQueueException.Kind.IO);
        }
        Set<String> committedBaseNames = new HashSet<>();
        for (File file : files) {
            String name = file.getName();
            if (name.endsWith(".sq")) {
                committedBaseNames.add(name);
            } else if (name.endsWith(".sq.bak")) {
                committedBaseNames.add(name.substring(0, name.length() - 4));
            }
            if (file.isFile() && !file.delete()) {
                throw new SecureQueueException(SecureQueueException.Kind.IO);
            }
        }
        return committedBaseNames.size();
    }

    private SecureQueueRecordCodec.Record open(
        byte[] envelope,
        byte[] digest,
        SecretKey storageKey
    ) throws SecureQueueException {
        if (envelope.length < ENVELOPE_MAGIC.length + NONCE_BYTES + (TAG_BITS / Byte.SIZE)) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        byte[] magic = Arrays.copyOfRange(envelope, 0, ENVELOPE_MAGIC.length);
        if (!MessageDigest.isEqual(magic, ENVELOPE_MAGIC)) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        int nonceEnd = ENVELOPE_MAGIC.length + NONCE_BYTES;
        byte[] nonce = Arrays.copyOfRange(envelope, ENVELOPE_MAGIC.length, nonceEnd);
        byte[] ciphertext = Arrays.copyOfRange(envelope, nonceEnd, envelope.length);
        final Cipher cipher;
        try {
            cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, storageKey, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(authenticatedData(digest));
        } catch (GeneralSecurityException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.KEY_UNAVAILABLE);
        }
        final byte[] plaintext;
        try {
            plaintext = cipher.doFinal(ciphertext);
        } catch (AEADBadTagException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        } catch (GeneralSecurityException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        return SecureQueueRecordCodec.decode(plaintext);
    }

    private byte[] read(AtomicFile atomicFile) throws SecureQueueException {
        try (InputStream input = atomicFile.openRead();
            ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        } catch (IOException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.IO);
        }
    }

    private SecretKey loadStorageKey(boolean allowCreate) throws SecureQueueException {
        try {
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
            keyStore.load(null);
            Key existing = keyStore.getKey(keyAlias, null);
            if (existing != null) {
                if (existing instanceof SecretKey secretKey) {
                    return secretKey;
                }
                throw new SecureQueueException(SecureQueueException.Kind.KEY_UNAVAILABLE);
            }
            if (!allowCreate) {
                throw new SecureQueueException(SecureQueueException.Kind.KEY_UNAVAILABLE);
            }
            KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                KEYSTORE_PROVIDER
            );
            generator.init(
                new KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(false)
                    .build()
            );
            return generator.generateKey();
        } catch (SecureQueueException exception) {
            throw exception;
        } catch (GeneralSecurityException | IOException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.KEY_UNAVAILABLE);
        }
    }

    private long nextRevision(long revision) throws SecureQueueException {
        if (revision == Long.MAX_VALUE) {
            throw new SecureQueueException(SecureQueueException.Kind.REVISION_CONFLICT);
        }
        return revision + 1;
    }

    private boolean hasCommittedRecords() throws SecureQueueException {
        File[] files = directory.listFiles();
        if (files == null) {
            throw new SecureQueueException(SecureQueueException.Kind.IO);
        }
        for (File file : files) {
            if (file.getName().endsWith(".sq") || file.getName().endsWith(".sq.bak")) {
                return true;
            }
        }
        return false;
    }

    private void ensureDirectory() throws SecureQueueException {
        if (directory.isDirectory()) {
            return;
        }
        if (directory.exists() || !directory.mkdirs()) {
            throw new SecureQueueException(SecureQueueException.Kind.IO);
        }
    }

    private File recordFile(byte[] digest) throws SecureQueueException {
        return new File(directory, SecureQueueRecordCodec.filenameForDigest(digest));
    }

    private static boolean committedFileExists(File baseFile) {
        return baseFile.isFile() || new File(baseFile.getPath() + ".bak").isFile();
    }

    private static byte[] authenticatedData(byte[] digest) {
        return ByteBuffer.allocate(ENVELOPE_MAGIC.length + digest.length)
            .put(ENVELOPE_MAGIC)
            .put(digest)
            .array();
    }
}
