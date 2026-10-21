// Shared serialized source-fence identities and desktop process ownership.
// macOS callers bind a fixed private directory and persist the anchor in the
// native-only Keychain. iOS compiles only the shared value types. This file
// itself never accesses Keychain or captures audio.
import Foundation
#if os(macOS)
import Darwin
#endif

enum NativeFenceError: Error { case unavailable }

struct NativeFenceFileIdentity: Codable, Equatable, Sendable {
    let device: Int64
    let inode: UInt64
}

struct NativeFenceAnchor: Codable, Equatable, Sendable {
    let coordinator: NativeFenceFileIdentity
    let capture: NativeFenceFileIdentity
    // st_dev identifies this mount, not this volume across a macOS restart.
    // Optional only to read the original journal without discarding custody.
    let volumeID: String?

    init(coordinator: NativeFenceFileIdentity, capture: NativeFenceFileIdentity, volumeID: String? = nil) {
        self.coordinator = coordinator; self.capture = capture; self.volumeID = volumeID
    }

    func matchesMountedFiles(_ current: NativeFenceAnchor, allowLegacyRemount: Bool) -> Bool {
        guard coordinator.inode == current.coordinator.inode, capture.inode == current.capture.inode,
              let currentVolume = current.volumeID else { return false }
        if let volumeID { return volumeID == currentVolume }
        return (coordinator == current.coordinator && capture == current.capture) || allowLegacyRemount
    }
}

#if os(macOS)
// Cross-process filesystem custody is desktop-only. iOS owns capture through
// NativeCaptureStartGate and must not link unused filesystem metadata APIs.
private final class NativeFenceFile {
    private let directory: Int32
    private let descriptor: Int32
    private let name: String
    let identity: NativeFenceFileIdentity
    let volumeID: String

    init(directoryPath: String, name: String, create: Bool) throws {
        let directory = try nativeFenceDirectory(directoryPath)
        guard directory >= 0 else { throw NativeFenceError.unavailable }
        var directoryStat = stat()
        guard fstat(directory, &directoryStat) == 0,
              directoryStat.st_uid == getuid(), directoryStat.st_mode & 0o777 == 0o700 else {
            Darwin.close(directory); throw NativeFenceError.unavailable
        }
        let descriptor = openat(directory, name, O_RDWR | O_NOFOLLOW | O_CLOEXEC | (create ? O_CREAT : 0), 0o600)
        guard descriptor >= 0 else { Darwin.close(directory); throw NativeFenceError.unavailable }
        var fileStat = stat()
        guard fstat(descriptor, &fileStat) == 0, fileStat.st_mode & S_IFMT == S_IFREG,
              fileStat.st_uid == getuid(), fileStat.st_mode & 0o777 == 0o600,
              fileStat.st_nlink == 1 else {
            Darwin.close(descriptor); Darwin.close(directory); throw NativeFenceError.unavailable
        }
        let stableVolume: String
        do { stableVolume = try nativeFenceVolumeID(descriptor) }
        catch { Darwin.close(descriptor); Darwin.close(directory); throw error }
        self.directory = directory; self.descriptor = descriptor; self.name = name
        identity = NativeFenceFileIdentity(device: Int64(fileStat.st_dev), inode: UInt64(fileStat.st_ino))
        volumeID = stableVolume
        try verifyPath()
        guard fsync(descriptor) == 0, fsync(directory) == 0 else { throw NativeFenceError.unavailable }
    }

    deinit { Darwin.close(descriptor); Darwin.close(directory) }

    func verifyPath() throws {
        var value = stat()
        guard fstatat(directory, name, &value, AT_SYMLINK_NOFOLLOW) == 0,
              value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1,
              value.st_uid == getuid(), value.st_mode & 0o777 == 0o600,
              Int64(value.st_dev) == identity.device, UInt64(value.st_ino) == identity.inode else {
            throw NativeFenceError.unavailable
        }
        guard try nativeFenceVolumeID(descriptor) == volumeID else { throw NativeFenceError.unavailable }
    }

    func lock(_ operation: Int32) throws {
        guard flock(descriptor, operation | LOCK_NB) == 0 else { throw NativeFenceError.unavailable }
        try verifyPath()
    }

    func unlock() throws {
        try verifyPath()
        guard flock(descriptor, LOCK_UN) == 0 else { throw NativeFenceError.unavailable }
    }

    func isEmpty() throws -> Bool {
        var value = stat()
        guard fstat(descriptor, &value) == 0 else { throw NativeFenceError.unavailable }
        return value.st_size == 0
    }

    func writeEpoch(_ epoch: String) throws {
        guard UUID(uuidString: epoch)?.uuidString.lowercased() == epoch else { throw NativeFenceError.unavailable }
        let bytes = Array((epoch + "\n").utf8)
        guard ftruncate(descriptor, 0) == 0,
              bytes.withUnsafeBytes({ pwrite(descriptor, $0.baseAddress, $0.count, 0) }) == bytes.count,
              fsync(descriptor) == 0 else { throw NativeFenceError.unavailable }
        try verifyPath()
    }

    func readEpoch() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 40)
        let count = bytes.withUnsafeMutableBytes { pread(descriptor, $0.baseAddress, $0.count, 0) }
        guard count == 37, bytes[36] == 10,
              let epoch = String(bytes: bytes.prefix(36), encoding: .utf8),
              UUID(uuidString: epoch)?.uuidString.lowercased() == epoch else { throw NativeFenceError.unavailable }
        try verifyPath()
        return epoch
    }
}

/// Hold coordinator exclusivity for the whole auth-helper lifetime. Capture
/// exclusivity is released only after the native journal is durably initialized
/// and every restored owner has an authenticated terminal acknowledgement.
final class NativeCaptureProcessCoordinator {
    private let coordinator: NativeFenceFile
    private let capture: NativeFenceFile
    private var captureReleased = false
    let anchor: NativeFenceAnchor
    let epoch: String

    init(privateDirectory: String, expectedAnchor: NativeFenceAnchor?, allowLegacyRemount: Bool = false) throws {
        coordinator = try NativeFenceFile(directoryPath: privateDirectory, name: "coordinator.lock", create: expectedAnchor == nil)
        try coordinator.lock(LOCK_EX)
        capture = try NativeFenceFile(directoryPath: privateDirectory, name: "capture.lock", create: expectedAnchor == nil)
        try capture.lock(LOCK_EX)
        guard coordinator.volumeID == capture.volumeID else { throw NativeFenceError.unavailable }
        anchor = NativeFenceAnchor(coordinator: coordinator.identity, capture: capture.identity, volumeID: coordinator.volumeID)
        if let expectedAnchor {
            guard expectedAnchor.matchesMountedFiles(anchor, allowLegacyRemount: allowLegacyRemount) else {
                throw NativeFenceError.unavailable
            }
        } else {
            // Never infer a fresh installation from a missing Keychain anchor
            // when a prior coordinator has already written its durable epoch.
            guard try coordinator.isEmpty(), try capture.isEmpty() else { throw NativeFenceError.unavailable }
        }
        epoch = UUID().uuidString.lowercased()
        try capture.writeEpoch(epoch)
    }

    func allowCaptureAfterConfirmedRecovery() throws {
        try coordinator.verifyPath()
        if captureReleased { return }
        try capture.unlock()
        captureReleased = true
    }

    var wireValue: [String: Any] {
        ["epoch": epoch, "coordinatorDevice": String(anchor.coordinator.device),
         "coordinatorInode": String(anchor.coordinator.inode), "captureDevice": String(anchor.capture.device),
         "captureInode": String(anchor.capture.inode)]
    }
}

/// Hold this object before constructing an audio source and until all native
/// audio resources have closed/the helper exits. No timeout establishes idle.
final class NativeCaptureProcessLease {
    private let capture: NativeFenceFile
    private let coordinator: NativeFenceFile

    init(privateDirectory: String, expectedAnchor: NativeFenceAnchor, expectedEpoch: String) throws {
        capture = try NativeFenceFile(directoryPath: privateDirectory, name: "capture.lock", create: false)
        try capture.lock(LOCK_SH)
        coordinator = try NativeFenceFile(directoryPath: privateDirectory, name: "coordinator.lock", create: false)
        guard coordinator.identity == expectedAnchor.coordinator,
              capture.identity == expectedAnchor.capture, try capture.readEpoch() == expectedEpoch else {
            throw NativeFenceError.unavailable
        }
    }
}
#endif

struct NativeFenceTicket: Sendable {
    let anchor: NativeFenceAnchor
    let epoch: String
    init(_ raw: Any?) throws {
        guard let value = raw as? [String: Any],
              Set(value.keys) == ["epoch", "coordinatorDevice", "coordinatorInode", "captureDevice", "captureInode"],
              let epoch = value["epoch"] as? String,
              UUID(uuidString: epoch)?.uuidString.lowercased() == epoch else { throw NativeFenceError.unavailable }
        func device(_ key: String) throws -> Int64 {
            guard let text = value[key] as? String, let result = Int64(text), String(result) == text else {
                throw NativeFenceError.unavailable
            }; return result
        }
        func inode(_ key: String) throws -> UInt64 {
            guard let text = value[key] as? String, let result = UInt64(text), result > 0, String(result) == text else {
                throw NativeFenceError.unavailable
            }; return result
        }
        self.epoch = epoch
        anchor = try NativeFenceAnchor(coordinator: .init(device: device("coordinatorDevice"), inode: inode("coordinatorInode")),
            capture: .init(device: device("captureDevice"), inode: inode("captureInode")))
    }
}

/// Open every component without following symlinks, including ancestors. The
/// final directory's private ownership/mode is checked by NativeFenceFile.
#if os(macOS)
// Read the volume UUID from the already-open descriptor. A path-based resource
// lookup could race replacement; an unavailable UUID never becomes permission.
private func nativeFenceVolumeID(_ descriptor: Int32) throws -> String {
    var attributes = attrlist()
    attributes.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
    attributes.volattr = ATTR_VOL_INFO | UInt32(ATTR_VOL_UUID)
    var bytes = [UInt8](repeating: 0, count: 20)
    let result = bytes.withUnsafeMutableBytes {
        fgetattrlist(descriptor, &attributes, $0.baseAddress, $0.count, 0)
    }
    guard result == 0, bytes.withUnsafeBytes({ $0.loadUnaligned(as: UInt32.self) }) == 20,
          bytes.dropFirst(4).contains(where: { $0 != 0 }) else { throw NativeFenceError.unavailable }
    let uuid = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 4, as: uuid_t.self) }
    return UUID(uuid: uuid).uuidString.lowercased()
}

private func nativeFenceDirectory(_ path: String) throws -> Int32 {
    guard path.hasPrefix("/") else { throw NativeFenceError.unavailable }
#if SCRIBE_MAC_APP_STORE_XPC
    // Ancestors are searched, never listed. Preserve read access on the final
    // private directory, including the empty-component root case.
    var remainingComponents = path.split(separator: "/").count
    let rootFlags = remainingComponents == 0 ? O_RDONLY | O_DIRECTORY | O_CLOEXEC : O_SEARCH | O_CLOEXEC
    var fd = open("/", rootFlags)
#else
    var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
#endif
    guard fd >= 0 else { throw NativeFenceError.unavailable }
    do {
        for part in path.split(separator: "/") {
            guard part != ".", part != ".." else { throw NativeFenceError.unavailable }
#if SCRIBE_MAC_APP_STORE_XPC
            remainingComponents -= 1
            let flags = remainingComponents == 0 ? O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                : O_SEARCH | O_NOFOLLOW | O_CLOEXEC
            let next = openat(fd, String(part), flags)
#else
            let next = openat(fd, String(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
#endif
            guard next >= 0 else { throw NativeFenceError.unavailable }
            Darwin.close(fd); fd = next
        }
        return fd
    } catch { Darwin.close(fd); throw error }
}

/// No command-line/renderer/environment path is accepted. Only the two new
/// private directories can be created; existing parent permissions are retained.
func nativeDesktopFenceDirectory() throws -> String {
#if SCRIBE_MAC_APP_STORE
    return try NativeDesktopStoreContainer.fenceDirectory()
#else
    guard let record = getpwuid(getuid()), let home = record.pointee.pw_dir else { throw NativeFenceError.unavailable }
    let path = String(cString: home) + "/Library/Application Support/com.cosmaneura.scribe.beta.desktop/SourceFence"
    var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { throw NativeFenceError.unavailable }
    defer { Darwin.close(fd) }
    let components = path.split(separator: "/")
    for (index, part) in components.enumerated() {
        guard part != ".", part != ".." else { throw NativeFenceError.unavailable }
        if index >= components.count - 2 {
            if mkdirat(fd, String(part), 0o700) != 0 && errno != EEXIST { throw NativeFenceError.unavailable }
            guard fsync(fd) == 0 else { throw NativeFenceError.unavailable }
        }
        let next = openat(fd, String(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard next >= 0 else { throw NativeFenceError.unavailable }
        Darwin.close(fd); fd = next
        var info = stat()
        guard fstat(fd, &info) == 0, [0, getuid()].contains(info.st_uid), info.st_mode & 0o022 == 0,
              index < components.count - 2 || (info.st_uid == getuid() && info.st_mode & 0o777 == 0o700)
        else { throw NativeFenceError.unavailable }
    }
    return path
#endif
}
#endif
