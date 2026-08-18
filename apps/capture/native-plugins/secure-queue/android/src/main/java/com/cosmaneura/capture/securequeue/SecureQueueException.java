package com.cosmaneura.capture.securequeue;

final class SecureQueueException extends Exception {
    enum Kind {
        INVALID_ARGUMENT,
        NOT_FOUND,
        ALREADY_EXISTS,
        REVISION_CONFLICT,
        CORRUPT,
        KEY_UNAVAILABLE,
        IO
    }

    private final Kind kind;

    SecureQueueException(Kind kind) {
        super(publicMessageFor(kind));
        this.kind = kind;
    }

    Kind kind() {
        return kind;
    }

    String code() {
        return switch (kind) {
            case INVALID_ARGUMENT -> "SECURE_QUEUE_INVALID_ARGUMENT";
            case NOT_FOUND -> "SECURE_QUEUE_NOT_FOUND";
            case ALREADY_EXISTS -> "SECURE_QUEUE_ALREADY_EXISTS";
            case REVISION_CONFLICT -> "SECURE_QUEUE_REVISION_CONFLICT";
            case CORRUPT -> "SECURE_QUEUE_CORRUPT";
            case KEY_UNAVAILABLE -> "SECURE_QUEUE_KEY_UNAVAILABLE";
            case IO -> "SECURE_QUEUE_IO";
        };
    }

    String publicMessage() {
        return publicMessageFor(kind);
    }

    private static String publicMessageFor(Kind kind) {
        return switch (kind) {
            case INVALID_ARGUMENT -> "Invalid secure queue request.";
            case NOT_FOUND -> "Secure queue record not found.";
            case ALREADY_EXISTS -> "Secure queue record already exists.";
            case REVISION_CONFLICT -> "Secure queue record changed.";
            case CORRUPT -> "Secure queue record is unavailable.";
            case KEY_UNAVAILABLE -> "Secure queue key is unavailable.";
            case IO -> "Secure queue operation failed.";
        };
    }
}
