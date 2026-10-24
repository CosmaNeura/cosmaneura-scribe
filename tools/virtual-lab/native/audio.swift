import AVFoundation
import AudioToolbox
import CoreAudio
import CoreGraphics
import CryptoKit
import Foundation

// This probe/player only selects BlackHole on its own AudioUnit, never the OS default.
enum Failure: Error { case invalid, unavailable, denied, empty }
func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
func json(_ path: String) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any]
    else { throw Failure.invalid }; return value
}
func child(_ path: String, _ root: String) throws -> URL {
    let url = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    let base = URL(fileURLWithPath: root).resolvingSymlinksInPath().standardizedFileURL.path
    guard url.path.hasPrefix(base + "/") else { throw Failure.invalid }; return url
}
func property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?; var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let value else { throw Failure.unavailable }
    return value.takeRetainedValue() as String
}
func devices() throws -> [(AudioObjectID, String, String)] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
          size <= 4096, size % UInt32(MemoryLayout<AudioObjectID>.size) == 0 else { throw Failure.unavailable }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { throw Failure.unavailable }
    return try ids.compactMap { id in
        let name = try property(id, kAudioObjectPropertyName)
        guard name.hasPrefix("BlackHole") else { return nil }
        var transportAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var transport: UInt32 = 0; var bytes = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &transportAddress, 0, nil, &bytes, &transport) == noErr,
              transport == kAudioDeviceTransportTypeVirtual else { return nil }
        return (id, try property(id, kAudioDevicePropertyDeviceUID), name)
    }
}
func select(_ unit: AudioUnit?, _ device: AudioObjectID) throws {
    guard let unit else { throw Failure.unavailable }; var id = device
    guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                               &id, UInt32(MemoryLayout<AudioObjectID>.size)) == noErr else { throw Failure.unavailable }
    var observed: AudioObjectID = 0; var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                               &observed, &size) == noErr, observed == device else { throw Failure.unavailable }
}
final class Counts: @unchecked Sendable {
    let lock = NSLock(); var frames = 0; var nonzero = 0; var sum = 0.0
    func add(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData else { return }
        lock.lock(); defer { lock.unlock() }
        frames += Int(buffer.frameLength)
        for i in 0..<Int(buffer.frameLength) {
            let value = Double(data[0][i])
            if value.isFinite { sum += value * value; if abs(value) > 0.00001 { nonzero += 1 } }
        }
    }
    func snapshot() -> (Int, Int, Double) {
        lock.lock(); defer { lock.unlock() }; return (frames, nonzero, frames > 0 ? sqrt(sum / Double(frames)) : 0)
    }
}
do {
    guard CommandLine.arguments.count == 3 else { throw Failure.invalid }
    let mode = CommandLine.arguments[1], config = try json(CommandLine.arguments[2])
    guard let target = config["target"] as? [String: Any], let root = target["root"] as? String,
          let markerPath = target["marker"] as? String, let hostname = target["hostname"] as? String,
          hostname == ProcessInfo.processInfo.hostName, let role = target["role"] as? String,
          ["owned-macos-guest", "owned-ios-simulator"].contains(role) else { throw Failure.invalid }
    let marker = try json(child(markerPath, root).path)
    guard marker["purpose"] as? String == "scribe-synthetic-virtual-lab", marker["hostname"] as? String == hostname,
          marker["role"] as? String == role else { throw Failure.invalid }
    if role == "owned-ios-simulator" {
        guard let udid = target["udid"] as? String, !udid.isEmpty, marker["udid"] as? String == udid else { throw Failure.invalid }
    }
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let locked = session?["CGSSessionScreenIsLocked"] as? Bool
    let inventory = try devices()
    if mode == "inventory" {
        emit(["devices": inventory.map { ["uid": $0.1, "name": $0.2] },
              "sessionLocked": locked as Any? ?? NSNull(),
              "microphoneAuthorized": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized])
    } else {
        guard mode == "probe" || mode == "play", let audio = config["audio"] as? [String: Any],
              let uid = audio["uid"] as? String, let device = inventory.first(where: { $0.1 == uid }),
              let receiptPath = config["consentReceipt"] as? String else { throw Failure.invalid }
        let receipt = try json(child(receiptPath, root).path)
        guard receipt["syntheticOnly"] as? Bool == true, receipt["verified"] as? Bool == true,
              receipt["source"] as? String == "normal-consent-path", let record = receipt["recordId"] as? String,
              !record.isEmpty, let scenario = config["scenarioId"] as? String, !scenario.isEmpty,
              receipt["scenarioId"] as? String == scenario else { throw Failure.denied }
        if role == "owned-macos-guest" && locked != false { throw Failure.denied }
        let engine = AVAudioEngine()
        if mode == "probe" {
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw Failure.denied }
            try select(engine.inputNode.audioUnit, device.0)
            let format = engine.inputNode.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure.unavailable }
            let counts = Counts()
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in counts.add(buffer) }
            defer { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
            try engine.start(); RunLoop.current.run(until: Date().addingTimeInterval(3))
            let (frames, nonzero, rms) = counts.snapshot()
            emit(["kind": "virtual-route-probe", "boundary": "CoreAudio-HAL-to-AVAudioEngine",
                  "routePassed": frames > 0 && nonzero > 0, "sampleRate": format.sampleRate,
                  "frames": frames, "nonzeroFrames": nonzero, "rms": rms, "scribeCaptureProven": false])
            if frames == 0 || nonzero == 0 { exit(2) }
        } else {
            guard let path = audio["wav"] as? String, let expected = audio["sha256"] as? String else { throw Failure.invalid }
            let url = try child(path, root)
            guard let bytes = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber,
                  bytes.intValue <= 64 * 1024 * 1024 else { throw Failure.invalid }
            let data = try Data(contentsOf: url)
            guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == expected else { throw Failure.invalid }
            let file = try AVAudioFile(forReading: url), duration = Double(file.length) / file.processingFormat.sampleRate
            guard duration.isFinite, duration > 0, duration <= 600 else { throw Failure.invalid }
            try select(engine.outputNode.audioUnit, device.0)
            let player = AVAudioPlayerNode(); engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
            player.scheduleFile(file, at: nil); try engine.start(); player.play()
            RunLoop.current.run(until: Date().addingTimeInterval(duration + 0.25)); player.stop(); engine.stop()
            emit(["kind": "virtual-audio-playback", "completed": true, "durationSeconds": duration])
        }
    }
} catch { emit(["passed": false, "reason": "virtual-audio-precondition-failed"]); exit(2) }
