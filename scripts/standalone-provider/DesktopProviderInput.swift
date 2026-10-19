#if os(macOS)
import Darwin
import Foundation

/// Consume each complete pipe frame while its writer remains open. Foundation's
/// read(upToCount:) can wait to fill the requested count on a persistent pipe.
enum DesktopProviderInput {
    static func readFrames(_ receive: @Sendable (Data) -> Void) {
        var buffer = [UInt8](repeating: 0, count: 65_536)
        var pending = Data()
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(STDIN_FILENO, bytes.baseAddress, bytes.count)
            }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return }
            for byte in buffer.prefix(count) {
                if byte == 10 {
                    receive(pending); pending = Data()
                } else {
                    guard pending.count < 16 * 1024 * 1024 else { return }
                    pending.append(byte)
                }
            }
        }
    }
}
#if SCRIBE_MAC_APP_STORE_XPC
/// A descriptor-local reader owns a dup, and cancellation never closes an FD
/// underneath a blocked read. poll bounds the stop check to 100 milliseconds.
final class DesktopProviderStoreInput: @unchecked Sendable {
    private let lock = NSLock()
    private var descriptor: Int32
    private var stopped = false
    private var started = false

    init(duplicating descriptor: Int32) throws {
        let owned = Darwin.dup(descriptor)
        guard owned >= 0 else { throw ProviderNativeError.unavailable }
        guard fcntl(owned, F_SETFD, FD_CLOEXEC) == 0 else {
            Darwin.close(owned); throw ProviderNativeError.unavailable
        }
        self.descriptor = owned
    }

    deinit { closeOwned() }
    func stop() { lock.lock(); stopped = true; lock.unlock() }
    private var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    private func closeOwned() {
        lock.lock(); let owned = descriptor; descriptor = -1; lock.unlock()
        if owned >= 0 { Darwin.close(owned) }
    }

    @discardableResult func readFrames(_ receive: @Sendable (Data) -> Void) -> Int32 {
        lock.lock()
        guard !started else { lock.unlock(); return 70 }
        started = true; let owned = descriptor; lock.unlock()
        defer { closeOwned() }
        var buffer = [UInt8](repeating: 0, count: 65_536), pending = Data()
        while !cancelled {
            var readiness = pollfd(fd: owned, events: Int16(POLLIN), revents: 0)
            let ready = Darwin.poll(&readiness, 1, 100)
            if ready < 0 && errno == EINTR { continue }
            guard ready >= 0, !cancelled else { return 70 }
            if ready == 0 { continue }
            guard readiness.revents & Int16(POLLERR | POLLNVAL) == 0 else { return 70 }
            let count = buffer.withUnsafeMutableBytes { Darwin.read(owned, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count >= 0, !cancelled else { return 70 }
            if count == 0 { return pending.isEmpty ? 0 : 70 }
            for byte in buffer.prefix(count) {
                guard !cancelled else { return 70 }
                if byte == 10 { receive(pending); pending = Data() }
                else {
                    guard pending.count < 16 * 1024 * 1024 else { return 70 }
                    pending.append(byte)
                }
            }
        }
        return 70
    }
}
#endif
#endif
