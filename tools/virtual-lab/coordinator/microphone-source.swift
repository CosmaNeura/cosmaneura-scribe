import AVFoundation
import AudioToolbox
import CoreAudio
import CryptoKit
import Darwin
import Foundation

enum SourceFailure: Error { case invalid, unavailable, sourceLost }
let sourceRate = 16000.0
func hostSeconds() -> Double { AVAudioTime.seconds(forHostTime: mach_absolute_time()) }

/// The source clock counts samples actually supplied in output render callbacks.
/// It never reads a microphone, changes a system default, or claims native capture.
final class SourceClock: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [Float] = [], offset = 0, state = "silent"
    private var fixtureHash = "", pcmHash = "", startHost = 0.0
    private var ring = [Double](repeating: 0, count: 256), ringIndex = 0, sum = 0.0
    private var scheduled: [String: Any]?, firstSignal: [String: Any]?
    private var renderedFrames = 0, silentFrames = 0, nonzeroFrames = 0, callbackFrames = 0
    private var lastRenderHost = -Double.infinity
    let epochOriginMs: Double
    init(epochOriginMs: Double) { self.epochOriginMs = epochOriginMs }

    func load(_ value: [String: Any]) throws {
        guard let consent = value["consentRecordId"] as? String, !consent.isEmpty, consent.utf8.count <= 200,
              let base64 = value["base64"] as? String, base64.utf8.count <= 26_000_000,
              let data = Data(base64Encoded: base64), data.count <= 19_200_000, data.count >= 6400, data.count % 2 == 0,
              let expectedPCM = value["pcmSHA256"] as? String,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == expectedPCM,
              let hash = value["fixtureSha256"] as? String, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              value["frames"] as? Int == data.count / 2, value["sampleRate"] as? Int == 16000 else { throw SourceFailure.invalid }
        var decoded: [Float] = []; decoded.reserveCapacity(data.count / 2)
        var nonzero = 0, first: Int?
        for at in stride(from: 0, to: data.count, by: 2) {
            let signed = Int16(bitPattern: UInt16(data[at]) | UInt16(data[at + 1]) << 8)
            guard abs(Int(signed)) < 32760 else { throw SourceFailure.invalid }
            if signed != 0 { nonzero += 1; first = first ?? at / 2 }
            decoded.append(Float(signed) / 32768)
        }
        guard nonzero >= 1600, let first, first >= 1600 else { throw SourceFailure.invalid }
        lock.lock(); defer { lock.unlock() }
        guard state != "playing" && state != "scheduled" else { throw SourceFailure.invalid }
        samples = decoded; fixtureHash = hash; pcmHash = expectedPCM; offset = 0; state = "silent"
        ring = [Double](repeating: 0, count: 256); ringIndex = 0; sum = 0; scheduled = nil; firstSignal = nil
    }
    func schedule(hash: String, epochMs: Double, restart: Bool, now: Double) throws {
        lock.lock(); defer { lock.unlock() }
        let delay = (epochMs - epochOriginMs) / 1000 - now
        guard !samples.isEmpty, hash == fixtureHash, epochMs.isFinite, delay >= 0.1, delay <= 5,
              state != "playing", state != "scheduled", state != "failed", offset < samples.count,
              !restart || offset == 0 else { throw SourceFailure.invalid }
        startHost = (epochMs - epochOriginMs) / 1000; state = "scheduled"
        scheduled = ["startAtEpochMs": epochMs, "sampleEpochMs": epochOriginMs + now * 1000,
            "sampleContextSeconds": now, "startAtContextSeconds": startHost, "sourceOffsetSeconds": Double(offset) / sourceRate]
        ring = [Double](repeating: 0, count: 256); ringIndex = 0; sum = 0; firstSignal = nil; silentFrames = 0
    }
    func pause() {
        lock.lock(); defer { lock.unlock() }
        if state == "playing" || state == "scheduled" { state = "paused" }
        silentFrames = 0
    }
    func fail() { lock.lock(); state = "failed"; lock.unlock() }
    func render(_ output: UnsafeMutablePointer<Float>, frames: Int, host: Double) {
        lock.lock(); defer { lock.unlock() }
        guard host.isFinite, host >= lastRenderHost, frames > 0, frames <= 65536 else {
            state = "failed"; output.initialize(repeating: 0, count: frames); return
        }
        lastRenderHost = host; callbackFrames = frames
        for index in 0..<frames {
            let time = host + Double(index) / sourceRate
            if state == "scheduled" && time >= startHost { state = "playing" }
            var sample: Float = 0
            if state == "playing" && offset < samples.count {
                sample = samples[offset]; offset += 1
                if offset == samples.count { state = "ended" }
            }
            output[index] = sample
            let square = Double(sample) * Double(sample)
            sum += square - ring[ringIndex]; ring[ringIndex] = square; ringIndex = (ringIndex + 1) % 256
            renderedFrames += 1
            if sample == 0 { silentFrames += 1 } else { silentFrames = 0; nonzeroFrames += 1 }
            if firstSignal == nil && scheduled != nil && sum / 256 > 0.005 * 0.005 {
                let crossed = time + 1 / sourceRate
                firstSignal = ["observedAtEpochMs": epochOriginMs + crossed * 1000, "audioContextSeconds": crossed,
                    "sourceOffsetSeconds": Double(offset) / sourceRate, "pollingIntervalMs": 0, "analysisFrames": 256,
                    "measurement": "coreaudio-render-callback", "callbackFrames": frames]
            }
        }
    }
    func report(now: Double) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["graphKind": "coreaudio-output", "fixtureSha256": fixtureHash, "pcmSHA256": pcmHash,
            "playing": state == "playing" || state == "scheduled", "completed": state == "ended", "state": state,
            "offsetSeconds": Double(offset) / sourceRate, "frames": samples.count, "sampleRate": sourceRate,
            "rms": sqrt(max(0, sum) / 256), "renderedFrames": renderedFrames, "nonzeroOutputFrames": nonzeroFrames,
            "silentFrames": silentFrames, "callbackFrames": callbackFrames, "observedAtEpochMs": epochOriginMs + now * 1000,
            "scheduledClock": scheduled as Any? ?? NSNull(), "firstSignal": firstSignal as Any? ?? NSNull()]
    }
}

#if !MICROPHONE_SOURCE_TEST
func deviceProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?; var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let value else { throw SourceFailure.unavailable }
    return value.takeRetainedValue() as String
}
func virtualDevice(_ uid: String) throws -> (AudioObjectID, String) {
    guard uid == "BlackHole2ch_UID" else { throw SourceFailure.invalid }
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
          size > 0, size <= 4096, size % 4 == 0 else { throw SourceFailure.unavailable }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / 4)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { throw SourceFailure.unavailable }
    let candidates = try ids.filter { try deviceProperty($0, kAudioDevicePropertyDeviceUID) == uid }
    guard candidates.count == 1, let id = candidates.first else { throw SourceFailure.unavailable }
    let name = try deviceProperty(id, kAudioObjectPropertyName)
    address.mSelector = kAudioDevicePropertyTransportType
    var transport: UInt32 = 0; size = 4
    guard name.hasPrefix("BlackHole"), AudioObjectGetPropertyData(id, &address, 0, nil, &size, &transport) == noErr,
          transport == kAudioDeviceTransportTypeVirtual else { throw SourceFailure.invalid }
    return (id, name)
}
func selected(_ unit: AudioUnit?, device: AudioObjectID, install: Bool = false) throws {
    guard let unit else { throw SourceFailure.unavailable }
    var id = device, size = UInt32(MemoryLayout<AudioObjectID>.size)
    if install && AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, size) != noErr { throw SourceFailure.unavailable }
    var actual: AudioObjectID = 0
    guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &actual, &size) == noErr,
          actual == device else { throw SourceFailure.sourceLost }
}
@main struct MicrophoneSource {
    static func main() {
        do { try run() } catch { exit(2) }
    }
    static func run() throws {
        guard CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix("--scribe-virtual-lab-owner="),
              UUID(uuidString: String(CommandLine.arguments[1].dropFirst("--scribe-virtual-lab-owner=".count))) != nil else { throw SourceFailure.invalid }
        let parent = getppid(), began = hostSeconds(), origin = Date().timeIntervalSince1970 * 1000 - hostSeconds() * 1000
        let clock = SourceClock(epochOriginMs: origin), engine = AVAudioEngine()
        var source: AVAudioSourceNode?, chosen: (AudioObjectID, String)?, pending = Data(), initialized = false
        defer { engine.stop(); if let source { engine.detach(source) } }
        func reply(_ id: String, _ body: [String: Any]) throws {
            let data = try JSONSerialization.data(withJSONObject: ["id": id, "ok": true, "media": body], options: [.sortedKeys])
            FileHandle.standardOutput.write(data + Data([10]))
        }
        func snapshot() throws -> [String: Any] {
            guard let chosen, initialized, engine.isRunning else { throw SourceFailure.sourceLost }
            try selected(engine.outputNode.audioUnit, device: chosen.0)
            var value = clock.report(now: hostSeconds())
            guard value["state"] as? String != "failed" else { throw SourceFailure.sourceLost }
            value["output"] = ["running": engine.isRunning, "deviceUID": "BlackHole2ch_UID", "deviceName": chosen.1,
                "transport": "virtual", "deviceId": chosen.0, "sampleRate": engine.outputNode.outputFormat(forBus: 0).sampleRate]
            return value
        }
        while hostSeconds() - began < 900 && getppid() == parent && parent > 1 {
            var poll = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            let count = Darwin.poll(&poll, 1, 100)
            if count < 0 { throw SourceFailure.unavailable }
            if count == 0 { continue }
            var bytes = [UInt8](repeating: 0, count: 65536)
            let readCount = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if readCount <= 0 { return } // Parent EOF stops only this owned output graph.
            pending.append(contentsOf: bytes.prefix(readCount))
            guard pending.count <= 26_100_000 else { throw SourceFailure.invalid }
            while let newline = pending.firstIndex(of: 10) {
                guard getppid() == parent && hostSeconds() - began < 900 else { throw SourceFailure.unavailable }
                let line = pending.prefix(upTo: newline); pending.removeSubrange(...newline)
                guard let request = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                      let id = request["id"] as? String, UUID(uuidString: id) != nil, let command = request["command"] as? String else { throw SourceFailure.invalid }
                if command == "initialize" {
                    guard !initialized, request["deviceUID"] as? String == "BlackHole2ch_UID", let fixture = request["fixture"] as? [String: Any] else { throw SourceFailure.invalid }
                    try clock.load(fixture); chosen = try virtualDevice("BlackHole2ch_UID")
                    try selected(engine.outputNode.audioUnit, device: chosen!.0, install: true)
                    let outputUnit = engine.outputNode.audioUnit, outputDevice = chosen!.0
                    guard let format = AVAudioFormat(standardFormatWithSampleRate: sourceRate, channels: 1) else { throw SourceFailure.unavailable }
                    source = AVAudioSourceNode(format: format) { _, timestamp, frames, buffers in
                        let list = UnsafeMutableAudioBufferListPointer(buffers)
                        for buffer in list { if let bytes = buffer.mData { memset(bytes, 0, Int(buffer.mDataByteSize)) } }
                        guard list.count == 1, let data = list[0].mData, timestamp.pointee.mFlags.contains(.hostTimeValid) else { clock.fail(); return kAudio_ParamError }
                        // A device loss/reselection must produce silence before the
                        // next PCM sample, including a system-default fallback.
                        do { try selected(outputUnit, device: outputDevice) } catch { clock.fail(); return noErr }
                        clock.render(data.assumingMemoryBound(to: Float.self), frames: Int(frames), host: AVAudioTime.seconds(forHostTime: timestamp.pointee.mHostTime))
                        return noErr
                    }
                    engine.attach(source!); engine.connect(source!, to: engine.mainMixerNode, format: format)
                    try engine.start(); initialized = true
                } else {
                    _ = try snapshot()
                    if command == "schedule" {
                        guard let hash = request["fixtureSha256"] as? String, let epoch = request["startAtEpochMs"] as? Double,
                              let restart = request["restart"] as? Bool else { throw SourceFailure.invalid }
                        try clock.schedule(hash: hash, epochMs: epoch, restart: restart, now: hostSeconds())
                    } else if command == "load" {
                        guard let fixture = request["fixture"] as? [String: Any] else { throw SourceFailure.invalid }
                        try clock.load(fixture)
                    } else if command == "pause" {
                        clock.pause()
                        let deadline = hostSeconds() + 1
                        while (clock.report(now: hostSeconds())["silentFrames"] as? Int ?? 0) < 256 && hostSeconds() < deadline { Thread.sleep(forTimeInterval: 0.005) }
                        guard (clock.report(now: hostSeconds())["silentFrames"] as? Int ?? 0) >= 256 else { throw SourceFailure.sourceLost }
                    } else if command == "close" { engine.stop(); try reply(id, ["state": "closed"]); return }
                    else if command != "status" { throw SourceFailure.invalid }
                }
                try reply(id, snapshot())
            }
        }
        throw SourceFailure.unavailable
    }
}
#endif
