import AVFoundation
import CryptoKit
import Darwin
import Foundation
import IOKit

// Read-only clock sampling. This does not construct an audio graph, inspect a
// device, call the product, or alter clocks, permissions, power or lock settings.
private enum ClockFailure: Error { case invalid, unavailable }

private func systemString(_ key: String) throws -> String {
    var size = 0
    guard sysctlbyname(key, nil, &size, nil, 0) == 0, size > 1, size < 1024 else { throw ClockFailure.unavailable }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname(key, &bytes, &size, nil, 0) == 0 else { throw ClockFailure.unavailable }
    return String(cString: bytes)
}

private func hostIdentity() throws -> [String: Any] {
    var hostname = [CChar](repeating: 0, count: 256)
    guard gethostname(&hostname, hostname.count) == 0 else { throw ClockFailure.unavailable }
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    guard service != 0 else { throw ClockFailure.unavailable }
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String,
          UUID(uuidString: value) != nil else { throw ClockFailure.unavailable }
    return ["hostname": String(cString: hostname), "hardwareSHA256": SHA256.hash(data: Data(value.lowercased().utf8)).map { String(format: "%02x", $0) }.joined(),
        "bootSessionUUID": try systemString("kern.bootsessionuuid").lowercased(), "pid": getpid(), "parentPID": getppid()]
}

private func resolution(_ clock: clockid_t) -> Any {
    var value = timespec()
    guard clock_getres(clock, &value) == 0, value.tv_sec >= 0, value.tv_nsec >= 0 else { return NSNull() }
    return String(UInt64(value.tv_sec) * 1_000_000_000 + UInt64(value.tv_nsec))
}

@main private struct KernelClock {
    static func main() {
        do { try run() } catch { exit(2) }
    }

    static func run() throws {
        let prefix = "--scribe-virtual-lab-owner="
        guard CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix(prefix),
              let run = UUID(uuidString: String(CommandLine.arguments[1].dropFirst(prefix.count))) else { throw ClockFailure.invalid }
        let identity = try hostIdentity(), parent = getppid(), began = mach_continuous_time()
        var timebase = mach_timebase_info_data_t()
        guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.numer > 0, timebase.denom > 0 else { throw ClockFailure.unavailable }
        let limit = 900.0 * 1e9 * Double(timebase.denom) / Double(timebase.numer)
        var pending = Data(), count = 0
        while Double(mach_continuous_time() - began) < limit, getppid() == parent, parent > 1 {
            var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            let ready = Darwin.poll(&descriptor, 1, 100)
            guard ready >= 0 else { throw ClockFailure.unavailable }
            if ready == 0 { continue }
            var bytes = [UInt8](repeating: 0, count: 1024)
            let length = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if length == 0 { return }
            guard length > 0 else { throw ClockFailure.unavailable }
            pending.append(contentsOf: bytes.prefix(length))
            guard pending.count <= 1024 else { throw ClockFailure.invalid }
            while let newline = pending.firstIndex(of: 10) {
                let line = pending.prefix(upTo: newline)
                pending.removeSubrange(...newline)
                guard count < 64, getppid() == parent,
                      let request = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                      Set(request.keys) == ["operation", "nonce"], request["operation"] as? String == "sample",
                      let nonce = request["nonce"] as? String, UUID(uuidString: nonce) != nil else { throw ClockFailure.invalid }
                count += 1
                // The Node clock uses continuous time; Dispatch uptime and
                // AVAudioTime host timestamps exclude sleep. Retain both.
                let continuousBefore = mach_continuous_time()
                let absoluteBefore = mach_absolute_time()
                let dispatch = DispatchTime.now()
                let absoluteAfter = mach_absolute_time()
                let continuousAfter = mach_continuous_time()
                let audioBefore = AVAudioTime.seconds(forHostTime: absoluteBefore)
                let audioAfter = AVAudioTime.seconds(forHostTime: absoluteAfter)
                let response: [String: Any] = ["schema": 1, "source": "owned-kernel-clock", "runId": run.uuidString.lowercased(), "nonce": nonce.lowercased(), "sequence": count,
                    "identity": identity, "timebase": ["numer": timebase.numer, "denom": timebase.denom],
                    "continuousBeforeTicks": String(continuousBefore), "continuousAfterTicks": String(continuousAfter),
                    "absoluteBeforeTicks": String(absoluteBefore), "absoluteAfterTicks": String(absoluteAfter),
                    "dispatchRawTicks": String(dispatch.rawValue), "dispatchUptimeNs": String(dispatch.uptimeNanoseconds),
                    "audioBeforeSeconds": audioBefore, "audioAfterSeconds": audioAfter,
                    "audioBeforeRoundTripTicks": String(AVAudioTime.hostTime(forSeconds: audioBefore)),
                    "audioAfterRoundTripTicks": String(AVAudioTime.hostTime(forSeconds: audioAfter)),
                    "apiResolutionNs": ["uptimeRaw": resolution(CLOCK_UPTIME_RAW), "monotonicRaw": resolution(CLOCK_MONOTONIC_RAW)]]
                let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
                FileHandle.standardOutput.write(data + Data([10]))
            }
        }
    }
}
