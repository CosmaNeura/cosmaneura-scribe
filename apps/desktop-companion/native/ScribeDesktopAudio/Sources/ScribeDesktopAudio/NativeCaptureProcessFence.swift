// INERT PROPOSAL: not part of any selected app or source package.
// Callers must bind a fixed private directory and persist the anchor in the
// native-only Keychain. This file never accesses Keychain or captures audio.
import Darwin
import Foundation

enum NativeFenceError: Error { case unavailable }

struct NativeFenceFileIdentity: Codable, Equatable, Sendable {
    let device: Int64
    let inode: UInt64
}

struct NativeFenceAnchor: Codable, Equatable, Sendable {
    let coordinator: NativeFenceFileIdentity
    let capture: NativeFenceFileIdentity
}

private final class NativeFenceFile {
    private let directory: Int32
    private let descriptor: Int32
    private let name: String
    let identity: NativeFenceFileIdentity

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
        self.directory = directory; self.descriptor = descriptor; self.name = name
        identity = NativeFenceFileIdentity(device: Int64(fileStat.st_dev), inode: UInt64(fileStat.st_ino))
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

    init(privateDirectory: String, expectedAnchor: NativeFenceAnchor?) throws {
        coordinator = try NativeFenceFile(directoryPath: privateDirectory, name: "coordinator.lock", create: expectedAnchor == nil)
        try coordinator.lock(LOCK_EX)
        capture = try NativeFenceFile(directoryPath: privateDirectory, name: "capture.lock", create: expectedAnchor == nil)
        try capture.lock(LOCK_EX)
        anchor = NativeFenceAnchor(coordinator: coordinator.identity, capture: capture.identity)
        if let expectedAnchor {
            guard expectedAnchor == anchor else { throw NativeFenceError.unavailable }
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
private func nativeFenceDirectory(_ path: String) throws -> Int32 {
    guard path.hasPrefix("/") else { throw NativeFenceError.unavailable }
    var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { throw NativeFenceError.unavailable }
    do {
        for part in path.split(separator: "/") {
            guard part != ".", part != ".." else { throw NativeFenceError.unavailable }
            let next = openat(fd, String(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
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
