import Darwin
import Foundation

private enum NativePipeReadFailure: Error { case unavailable }

/// Descriptor-local cancellation for the private XPC transport. It never closes
/// a borrowed FD: the listener closes only after native output and reader drain.
public final class NativeProcessLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var action: (@Sendable () -> Void)?
    public init() {}
    public var isCancelled: Bool { lock.withLock { cancelled } }
    public func onCancel(_ action: @escaping @Sendable () -> Void) {
        let invoke = lock.withLock { () -> Bool in
            if cancelled { return true }
            self.action = action; return false
        }
        if invoke { action() }
    }
    public func cancel() {
        let invoke = lock.withLock { () -> (@Sendable () -> Void)? in
            guard !cancelled else { return nil }
            cancelled = true; defer { action = nil }; return action
        }
        invoke?()
    }
    public func finishReading() {
        lock.withLock { action = nil; cancelled = true }
    }
    func read(_ input: FileHandle, upToCount count: Int) throws -> Data? {
        while true {
            if isCancelled { throw CancellationError() }
            var descriptor = pollfd(fd: input.fileDescriptor, events: Int16(POLLIN), revents: 0)
            let result = poll(&descriptor, 1, 100)
            if result < 0 {
                if errno == EINTR { continue }
                throw NativePipeReadFailure.unavailable
            }
            if result == 0 { continue }
            if isCancelled { throw CancellationError() }
            guard descriptor.revents & Int16(POLLNVAL) == 0 else { throw NativePipeReadFailure.unavailable }
            var bytes = [UInt8](repeating: 0, count: count)
            let received = Darwin.read(input.fileDescriptor, &bytes, count)
            if received < 0 {
                if errno == EINTR || errno == EAGAIN { continue }
                throw NativePipeReadFailure.unavailable
            }
            if received == 0 { return nil }
            return Data(bytes.prefix(received))
        }
    }
}
