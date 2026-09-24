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
#endif
