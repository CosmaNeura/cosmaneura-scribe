import CoreFoundation
import Foundation

/// Read-only admission before native auth composition can initialize Clerk.
/// This does not prove legacy migration or authorize a clean installation.
@MainActor enum DesktopStoreClerkAdmission {
    enum Rejection: Error { case unavailable }

    static let appIdentifier = "com.cosmaneura.scribe.beta.desktop.auth"
    static let service = appIdentifier + ".clerk"
    static let accessGroup: String? = nil

    // Pinned Clerk+Installation uses UTF-8 lengths, with "n" for nil.
    static var markerKey: String {
        func encode(_ value: String?) -> String {
            guard let value else { return "n" }
            return "s\(value.utf8.count):\(value)"
        }
        return (["com.clerk.trusted-device-installation-marker"] +
                [service, accessGroup, appIdentifier].map(encode)).joined(separator: ".")
    }

    static func construct<Auth>(
        appIdentifier: String,
        readMarker: (String) throws -> Any?,
        makeAuth: () throws -> Auth
    ) throws -> Auth {
        guard appIdentifier == Self.appIdentifier else { throw Rejection.unavailable }
        let value: Any?
        do { value = try readMarker(markerKey) }
        catch { throw Rejection.unavailable }
        // Missing, false, malformed and protected/unknown reads all reject.
        // Do not accept NSNumber(1), strings or other coercions as a true marker.
        guard let value,
              CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID(),
              value as? Bool == true else { throw Rejection.unavailable }
        return try makeAuth()
    }
}
