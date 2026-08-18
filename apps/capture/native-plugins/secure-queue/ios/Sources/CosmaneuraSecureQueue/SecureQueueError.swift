import Foundation

enum SecureQueueError: Error, Equatable {
    case invalidArgument
    case notFound
    case alreadyExists
    case revisionConflict
    case corrupt
    case keyUnavailable
    case io

    var code: String {
        switch self {
        case .invalidArgument:
            return "SECURE_QUEUE_INVALID_ARGUMENT"
        case .notFound:
            return "SECURE_QUEUE_NOT_FOUND"
        case .alreadyExists:
            return "SECURE_QUEUE_ALREADY_EXISTS"
        case .revisionConflict:
            return "SECURE_QUEUE_REVISION_CONFLICT"
        case .corrupt:
            return "SECURE_QUEUE_CORRUPT"
        case .keyUnavailable:
            return "SECURE_QUEUE_KEY_UNAVAILABLE"
        case .io:
            return "SECURE_QUEUE_IO"
        }
    }

    var publicMessage: String {
        switch self {
        case .invalidArgument:
            return "Invalid secure queue request."
        case .notFound:
            return "Secure queue record not found."
        case .alreadyExists:
            return "Secure queue record already exists."
        case .revisionConflict:
            return "Secure queue record changed."
        case .corrupt:
            return "Secure queue record is unavailable."
        case .keyUnavailable:
            return "Secure queue key is unavailable."
        case .io:
            return "Secure queue operation failed."
        }
    }
}
