package com.cosmaneura.capture.securequeue;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class SecureQueueRecordCodecTest {
    @Test
    public void roundTripsOpaqueBytes() throws Exception {
        byte[] data = new byte[] {0x00, 0x01, (byte) 0xff};
        SecureQueueRecordCodec.Record record = SecureQueueRecordCodec.decode(
            SecureQueueRecordCodec.encode("opaque-record", data, 7)
        );

        assertEquals("opaque-record", record.key());
        assertArrayEquals(data, record.data());
        assertEquals(7, record.revision());
    }

    @Test
    public void rejectsInvalidKeysAndFrames() {
        SecureQueueException emptyKey = assertThrows(
            SecureQueueException.class,
            () -> SecureQueueRecordCodec.encode("", new byte[0], 1)
        );
        assertEquals(SecureQueueException.Kind.INVALID_ARGUMENT, emptyKey.kind());

        SecureQueueException invalidFrame = assertThrows(
            SecureQueueException.class,
            () -> SecureQueueRecordCodec.decode(new byte[] {0x00, 0x01})
        );
        assertEquals(SecureQueueException.Kind.CORRUPT, invalidFrame.kind());
    }

    @Test
    public void digestFilenameRoundTrips() throws Exception {
        byte[] digest = SecureQueueRecordCodec.digestForKey("opaque-record");
        String filename = SecureQueueRecordCodec.filenameForDigest(digest);
        assertArrayEquals(digest, SecureQueueRecordCodec.digestFromFilename(filename));
    }
}
