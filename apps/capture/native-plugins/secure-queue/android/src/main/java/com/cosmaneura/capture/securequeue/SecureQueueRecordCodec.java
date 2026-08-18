package com.cosmaneura.capture.securequeue;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

final class SecureQueueRecordCodec {
    static final int MAXIMUM_KEY_BYTES = 512;

    static final class Record {
        private final String key;
        private final byte[] data;
        private final long revision;

        Record(String key, byte[] data, long revision) {
            this.key = key;
            this.data = data.clone();
            this.revision = revision;
        }

        String key() {
            return key;
        }

        byte[] data() {
            return data.clone();
        }

        long revision() {
            return revision;
        }
    }

    private SecureQueueRecordCodec() {}

    static byte[] validatedKeyBytes(String key) throws SecureQueueException {
        if (key == null || key.isEmpty()) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        final ByteBuffer encoded;
        try {
            encoded = StandardCharsets.UTF_8
                .newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .encode(CharBuffer.wrap(key));
        } catch (CharacterCodingException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        if (encoded.remaining() > MAXIMUM_KEY_BYTES) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        byte[] bytes = new byte[encoded.remaining()];
        encoded.get(bytes);
        return bytes;
    }

    static byte[] encode(String key, byte[] data, long revision) throws SecureQueueException {
        byte[] keyBytes = validatedKeyBytes(key);
        if (revision <= 0) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        long encodedLength = Long.BYTES + Integer.BYTES + (long) keyBytes.length + data.length;
        if (encodedLength > Integer.MAX_VALUE) {
            throw new SecureQueueException(SecureQueueException.Kind.INVALID_ARGUMENT);
        }
        return ByteBuffer.allocate((int) encodedLength)
            .putLong(revision)
            .putInt(keyBytes.length)
            .put(keyBytes)
            .put(data)
            .array();
    }

    static Record decode(byte[] encoded) throws SecureQueueException {
        if (encoded.length < Long.BYTES + Integer.BYTES) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        ByteBuffer buffer = ByteBuffer.wrap(encoded);
        long revision = buffer.getLong();
        int keyLength = buffer.getInt();
        if (
            revision <= 0 ||
            keyLength <= 0 ||
            keyLength > MAXIMUM_KEY_BYTES ||
            keyLength > buffer.remaining()
        ) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        byte[] keyBytes = new byte[keyLength];
        buffer.get(keyBytes);
        final String key;
        try {
            key = StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(keyBytes))
                .toString();
        } catch (CharacterCodingException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        byte[] data = new byte[buffer.remaining()];
        buffer.get(data);
        return new Record(key, data, revision);
    }

    static byte[] digestForKey(String key) throws SecureQueueException {
        try {
            return MessageDigest.getInstance("SHA-256").digest(validatedKeyBytes(key));
        } catch (NoSuchAlgorithmException exception) {
            throw new SecureQueueException(SecureQueueException.Kind.KEY_UNAVAILABLE);
        }
    }

    static String filenameForDigest(byte[] digest) throws SecureQueueException {
        if (digest.length != 32) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        StringBuilder filename = new StringBuilder(67);
        for (byte value : digest) {
            filename.append(Character.forDigit((value >>> 4) & 0x0f, 16));
            filename.append(Character.forDigit(value & 0x0f, 16));
        }
        return filename.append(".sq").toString();
    }

    static byte[] digestFromFilename(String filename) throws SecureQueueException {
        if (!filename.matches("[0-9a-f]{64}\\.sq")) {
            throw new SecureQueueException(SecureQueueException.Kind.CORRUPT);
        }
        byte[] digest = new byte[32];
        for (int index = 0; index < digest.length; index += 1) {
            int offset = index * 2;
            int high = Character.digit(filename.charAt(offset), 16);
            int low = Character.digit(filename.charAt(offset + 1), 16);
            digest[index] = (byte) ((high << 4) | low);
        }
        return digest;
    }
}
