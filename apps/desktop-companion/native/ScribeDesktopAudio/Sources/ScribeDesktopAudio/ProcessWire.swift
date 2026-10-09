import CoreFoundation
import Foundation

/// Private inherited pipe protocol. No socket, renderer, filesystem audio or
/// credential interface. Frames are u32 big-endian length, u8 kind, then body.
/// Kind 1 is bounded metadata JSON; kind 2 is u32 frame offset + PCM16LE.
enum ProcessCommand: Sendable {
    case start(MeetingAudioSelection, duration: Int, frames: Int, fence: NativeFenceTicket)
    case startRenewable(MeetingAudioSelection, DesktopCaptureAuthorization, NativeFenceTicket)
    case extend(Int, DesktopCaptureAuthorization)
    case activate, heartbeat
    case acknowledge(Int)
    case stop(Int, DesktopAudioStopMode)

    static func parse(_ bytes: Data) throws -> ProcessCommand {
        guard bytes.first == 1, bytes.count <= 2048,
              let value = try JSONSerialization.jsonObject(with: bytes.dropFirst()) as? [String: Any],
              let kind = value["type"] as? String else { throw DesktopAudioFailure.invalidAudio }
        func keys(_ expected: Set<String>) throws {
            guard Set(value.keys) == expected else { throw DesktopAudioFailure.invalidAudio }
        }
        switch kind {
        case "startRenewable":
            try keys(["type", "application", "processID", "windowID", "authorization", "processFence"])
            guard let raw = value["application"] as? String,
                  let application = MeetingAudioSelection.Application(rawValue: raw) else { throw DesktopAudioFailure.selectionChanged }
            let pid = try integer(value["processID"], minimum: application == .microphone ? 0 : 1, maximum: Int(Int32.max))
            let window = try integer(value["windowID"], minimum: application == .microphone ? 0 : 1, maximum: Int(UInt32.max))
            return .startRenewable(try MeetingAudioSelection(application: application, processID: Int32(pid), windowID: UInt32(window)),
                try authorization(value["authorization"]), try NativeFenceTicket(value["processFence"]))
        case "extend":
            try keys(["type", "request", "authorization"])
            return .extend(try integer(value["request"], maximum: 1_000_000), try authorization(value["authorization"]))
        case "start":
            try keys(["type", "application", "processID", "windowID", "maximumDurationSeconds", "maximumOutputFrames", "processFence"])
            guard let raw = value["application"] as? String,
                  let application = MeetingAudioSelection.Application(rawValue: raw) else { throw DesktopAudioFailure.selectionChanged }
            let pid = try integer(value["processID"], minimum: application == .microphone ? 0 : 1, maximum: Int(Int32.max))
            let window = try integer(value["windowID"], minimum: application == .microphone ? 0 : 1, maximum: Int(UInt32.max))
            let duration = try integer(value["maximumDurationSeconds"], maximum: 86_400)
            let frames = try integer(value["maximumOutputFrames"], maximum: 1_382_400_000)
            guard frames <= duration * 16_000 else { throw DesktopAudioFailure.invalidAudio }
            return .start(try MeetingAudioSelection(application: application, processID: Int32(pid), windowID: UInt32(window)),
                          duration: duration, frames: frames, fence: try NativeFenceTicket(value["processFence"]))
        case "activate": try keys(["type"]); return .activate
        case "heartbeat": try keys(["type"]); return .heartbeat
        case "ack": try keys(["type", "firstFrame"]); return .acknowledge(try integer(value["firstFrame"], minimum: 0))
        case "stop":
            try keys(["type", "request", "mode"])
            guard let mode = value["mode"] as? String, ["drain", "discard"].contains(mode) else { throw DesktopAudioFailure.invalidAudio }
            return .stop(try integer(value["request"], maximum: 32), mode == "drain" ? .drain : .discard)
        default: throw DesktopAudioFailure.invalidAudio
        }
    }

    private static func authorization(_ value: Any?) throws -> DesktopCaptureAuthorization {
        guard let value = value as? [String: Any],
              Set(value.keys) == ["runId", "generation", "expiresAtMilliseconds", "maximumOutputFrames", "hardMaximumOutputFrames"],
              let runID = value["runId"] as? String else { throw DesktopAudioFailure.invalidAudio }
        return try DesktopCaptureAuthorization(runID: runID, generation: integer(value["generation"], maximum: 9_007_199_254_740_991),
            expiresAtMilliseconds: Int64(integer(value["expiresAtMilliseconds"], maximum: 9_007_199_254_740_991)),
            maximumOutputFrames: integer(value["maximumOutputFrames"]), hardMaximumOutputFrames: integer(value["hardMaximumOutputFrames"]))
    }

    private static func integer(_ value: Any?, minimum: Int = 1, maximum: Int = 1_382_400_000) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= Double(minimum), number.doubleValue <= Double(maximum) else {
            throw DesktopAudioFailure.invalidAudio
        }
        return number.intValue
    }
}

final class ProcessInput: @unchecked Sendable {
    private let input: FileHandle
    init(_ input: FileHandle) { self.input = input }
    func next() throws -> ProcessCommand? {
        guard let header = try readExactly(4) else { return nil }
        let length = header.reduce(0) { $0 * 256 + Int($1) }
        guard (2...2048).contains(length), let payload = try readExactly(length) else { throw DesktopAudioFailure.invalidAudio }
        return try ProcessCommand.parse(payload)
    }
    private func readExactly(_ length: Int) throws -> Data? {
        var result = Data()
        while result.count < length {
            guard let part = try input.read(upToCount: length - result.count), !part.isEmpty else {
                if result.isEmpty { return nil }
                throw DesktopAudioFailure.invalidAudio
            }
            result.append(part)
        }
        return result
    }
}

final class ProcessOutput: @unchecked Sendable {
    private let output: FileHandle
    private let queue = DispatchQueue(label: "scribe.desktop.private-pipe")
    private let lock = NSLock()
    private var valid = true
    init(_ output: FileHandle) { self.output = output }
    func metadata(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys), data.count < 2048 else {
            lock.withLock { valid = false }; return
        }
        enqueue(kind: 1, body: data)
    }
    func pcm(firstFrame: Int, bytes: Data) {
        guard (0...1_382_400_000).contains(firstFrame), (2...8192).contains(bytes.count), bytes.count % 2 == 0 else {
            lock.withLock { valid = false }; return
        }
        var body = Self.bigEndian(firstFrame); body.append(bytes)
        enqueue(kind: 2, body: body)
        body.resetBytes(in: 0..<body.count)
    }
    var isValid: Bool { lock.withLock { valid } }
    func invalidate() { lock.withLock { valid = false } }
    func drain() async { await withCheckedContinuation { continuation in queue.async { continuation.resume() } } }
    private func enqueue(kind: UInt8, body: Data) {
        var frame = Self.bigEndian(body.count + 1); frame.append(kind); frame.append(body)
        let owned = ProcessWireBytes(frame)
        queue.async { [self] in
            defer { owned.clear() }
            guard lock.withLock({ valid }) else { return }
            do { try owned.write(to: output) }
            catch { lock.withLock { valid = false } }
        }
        frame.resetBytes(in: 0..<frame.count)
    }
    private static func bigEndian(_ value: Int) -> Data {
        let n = UInt32(value)
        return Data([UInt8((n >> 24) & 255), UInt8((n >> 16) & 255), UInt8((n >> 8) & 255), UInt8(n & 255)])
    }
}

/// Reference ownership avoids leaving an immutable Data alias behind when its
/// mutable copy is cleared. FileHandle consumes the buffer synchronously.
private final class ProcessWireBytes: @unchecked Sendable {
    private var bytes: Data
    init(_ bytes: Data) { self.bytes = bytes }
    deinit { clear() }
    func write(to output: FileHandle) throws { try output.write(contentsOf: bytes) }
    func clear() { bytes.resetBytes(in: 0..<bytes.count) }
}

extension DesktopPCMStart {
    var wireValue: [String: String] {
        ["hostTimeNanoseconds": String(hostTimeNanoseconds),
         "microphonePrerollNanoseconds": String(microphonePrerollNanoseconds),
         "systemPrerollNanoseconds": String(systemPrerollNanoseconds)]
    }
}
extension DesktopPCMCompletion {
    var wireValue: [String: Any] {
        ["start": start.wireValue, "endHostTimeNanoseconds": String(endHostTimeNanoseconds),
         "outputFrames": outputFrames, "microphoneTailNanoseconds": String(microphoneTailNanoseconds),
         "systemTailNanoseconds": String(systemTailNanoseconds)]
    }
}
