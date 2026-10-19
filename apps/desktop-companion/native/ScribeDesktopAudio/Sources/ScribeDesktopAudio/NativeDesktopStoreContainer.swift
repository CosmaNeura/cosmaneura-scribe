#if os(macOS)
import Darwin
import Foundation
import Security

/// Compiled distribution choice. No bundle setting, pipe, argv or environment
/// value can enable the store path or select a container. Remains unavailable
/// until an independently reviewed Apple App Group/profile identity is pinned.
public enum NativeDesktopStoreContainer {
    public static let approvedApplicationGroup: String? = nil
    static let team = "JVV65668U6"
    static let parent = "com.cosmaneura.scribe.beta.desktop"
    static let auth = parent + ".auth"
    static let helpers = [auth, parent + ".audio", parent + ".presentation"]

    public static func requireContainer() throws -> String {
        guard let group = approvedApplicationGroup else { throw StoreContainerError.unavailable }
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, [], nil) == errSecSuccess else { throw StoreContainerError.unavailable }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { throw StoreContainerError.unavailable }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let signed = information as? [String: Any],
              let claims = signed[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
              let identifier = signed[kSecCodeInfoIdentifier as String] as? String,
              let bundle = Bundle.main.bundleIdentifier,
              identifier == bundle else { throw StoreContainerError.unavailable }
        try validateMembership(claims, bundle: bundle, approvedGroup: group)
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              url.isFileURL, url.path.hasPrefix("/"), url.standardizedFileURL.path == url.path,
              url.resolvingSymlinksInPath().path == url.path else { throw StoreContainerError.unavailable }
        let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw StoreContainerError.unavailable }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o022 == 0 else {
            throw StoreContainerError.unavailable
        }
        return url.path
    }

    static func validateMembership(_ claims: [String: Any], bundle: String, approvedGroup: String) throws {
        let sandbox = claims["com.apple.security.app-sandbox"]
        let identityKeys: Set<String> = ["com.apple.security.app-sandbox", "com.apple.security.application-groups",
            "com.apple.developer.team-identifier", "com.apple.application-identifier"]
        let roleKeys: Set<String> = bundle == auth ? ["keychain-access-groups", "com.apple.security.network.client"]
            : bundle == parent + ".audio" ? ["com.apple.security.device.audio-input"] : []
        guard !approvedGroup.isEmpty, !approvedGroup.contains("/"),
              helpers.contains(bundle),
              Set(claims.keys) == identityKeys.union(roleKeys),
              sandbox.map({ CFGetTypeID($0 as CFTypeRef) == CFBooleanGetTypeID() }) == true,
              sandbox as? Bool == true,
              claims["com.apple.security.application-groups"] as? [String] == [approvedGroup],
              claims["com.apple.developer.team-identifier"] as? String == team,
              claims["com.apple.application-identifier"] as? String == team + "." + bundle else {
            throw StoreContainerError.unavailable
        }
        for key in roleKeys where key != "keychain-access-groups" {
            guard let value = claims[key], CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID(),
                  value as? Bool == true else { throw StoreContainerError.unavailable }
        }
        // Only the native identity owner receives access to existing credentials.
        if bundle == auth {
            guard claims["keychain-access-groups"] as? [String] == [team + "." + auth] else {
                throw StoreContainerError.unavailable
            }
        } else if claims["keychain-access-groups"] != nil {
            throw StoreContainerError.unavailable
        }
    }

    /// Creates only this private child below the OS-approved container. The
    /// process fence still owns O_NOFOLLOW, UID/mode, inode, lock and epoch checks.
    public static func fenceDirectory() throws -> String {
        let root = try requireContainer()
        let descriptor = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw StoreContainerError.unavailable }
        defer { Darwin.close(descriptor) }
        var parentInfo = stat()
        guard fstat(descriptor, &parentInfo) == 0, parentInfo.st_uid == getuid(), parentInfo.st_mode & 0o022 == 0,
              URL(fileURLWithPath: root).resolvingSymlinksInPath().path == root else {
            throw StoreContainerError.unavailable
        }
        if mkdirat(descriptor, "SourceFence", 0o700) != 0 && errno != EEXIST {
            throw StoreContainerError.unavailable
        }
        guard fsync(descriptor) == 0 else { throw StoreContainerError.unavailable }
        let child = openat(descriptor, "SourceFence", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { throw StoreContainerError.unavailable }
        defer { Darwin.close(child) }
        var info = stat()
        guard fstat(child, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            throw StoreContainerError.unavailable
        }
        return root + "/SourceFence"
    }
}

enum StoreContainerError: Error { case unavailable }
#endif
