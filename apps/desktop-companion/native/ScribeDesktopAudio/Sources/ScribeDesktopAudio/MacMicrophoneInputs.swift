@preconcurrency import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

/// Device identities remain in the trusted native/main boundary. The renderer
/// receives opaque choices; a disappeared device never falls back silently.
public struct MacMicrophoneInput: Sendable, Equatable {
    public let uid: String
    public let label: String
    public let kind: String
    let deviceID: AudioDeviceID
    var wireValue: [String: String] { ["uid": uid, "label": label, "kind": kind] }
}

public enum MacMicrophoneInputs {
    public static func list() throws -> [MacMicrophoneInput] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
              size <= 4096, size % UInt32(MemoryLayout<AudioDeviceID>.size) == 0 else { throw DesktopAudioFailure.unavailable }
        var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else {
            throw DesktopAudioFailure.unavailable
        }
        return try devices.compactMap { id in
            var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams,
                mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
            var bytes: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &bytes) == noErr, bytes > 0 else { return nil }
            let uid = try string(id, kAudioDevicePropertyDeviceUID)
            let rawLabel = try string(id, kAudioObjectPropertyName)
            guard !uid.isEmpty, uid.utf8.count <= 511, !uid.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
                throw DesktopAudioFailure.unavailable
            }
            let label = String(rawLabel.unicodeScalars.filter { $0.value >= 32 && $0.value != 127 }.prefix(160))
            var transportAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType,
                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var transport: UInt32 = 0, transportSize = UInt32(MemoryLayout<UInt32>.size)
            _ = AudioObjectGetPropertyData(id, &transportAddress, 0, nil, &transportSize, &transport)
            let kind: String = transport == kAudioDeviceTransportTypeBuiltIn ? "built_in"
                : transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE ? "bluetooth"
                : transport == kAudioDeviceTransportTypeUSB || transport == kAudioDeviceTransportTypeThunderbolt ? "external" : "unknown"
            return MacMicrophoneInput(uid: uid, label: label.isEmpty ? "Microphone" : label, kind: kind, deviceID: id)
        }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    public static func defaultUID() throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id: AudioDeviceID = 0, size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else {
            throw DesktopAudioFailure.unavailable
        }
        return try string(id, kAudioDevicePropertyDeviceUID)
    }

    static func select(_ uid: String, engine: AVAudioEngine) throws {
        guard let device = try list().first(where: { $0.uid == uid }), let unit = engine.inputNode.audioUnit else {
            throw DesktopAudioFailure.selectionChanged
        }
        var id = device.deviceID
        // Setting the device that HAL already selected can itself enqueue an
        // engine configuration notification. Keep a same-device choice a no-op.
        if try currentDevice(engine) != id {
            guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else { throw DesktopAudioFailure.selectionChanged }
        }
        guard try currentDevice(engine) == id else { throw DesktopAudioFailure.selectionChanged }
    }

    static func selectedUID(engine: AVAudioEngine) throws -> String {
        try selectedUID(deviceID: currentDevice(engine), isAlive: deviceIsAlive,
            hasInputStreams: deviceHasInputStreams,
            readUID: { try string($0, kAudioDevicePropertyDeviceUID) })
    }

    /// Validate only the device owned by this engine. A catalogue or name read
    /// on an unrelated device must not interrupt an authorized recording.
    /// These synchronous reads are injectable for tests that never open audio.
    static func selectedUID(deviceID: AudioDeviceID,
                            isAlive: (AudioDeviceID) throws -> Bool,
                            hasInputStreams: (AudioDeviceID) throws -> Bool,
                            readUID: (AudioDeviceID) throws -> String) throws -> String {
        guard deviceID != 0, try isAlive(deviceID), try hasInputStreams(deviceID) else {
            throw DesktopAudioFailure.selectionChanged
        }
        let uid = try readUID(deviceID)
        guard !uid.isEmpty, uid.utf8.count <= 511,
              !uid.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw DesktopAudioFailure.selectionChanged
        }
        return uid
    }

    private static func deviceIsAlive(_ id: AudioDeviceID) throws -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var alive: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &alive) == noErr,
              size == UInt32(MemoryLayout<UInt32>.size) else { throw DesktopAudioFailure.selectionChanged }
        return alive == 1
    }

    private static func deviceHasInputStreams(_ id: AudioDeviceID) throws -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr,
              size <= 4096, size % UInt32(MemoryLayout<AudioStreamID>.size) == 0 else {
            throw DesktopAudioFailure.selectionChanged
        }
        return size > 0
    }

    private static func currentDevice(_ engine: AVAudioEngine) throws -> AudioDeviceID {
        guard let unit = engine.inputNode.audioUnit else { throw DesktopAudioFailure.selectionChanged }
        var id: AudioDeviceID = 0, size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
            0, &id, &size) == noErr, size == UInt32(MemoryLayout<AudioDeviceID>.size), id != 0 else {
            throw DesktopAudioFailure.selectionChanged
        }
        return id
    }

    private static func string(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var result: Unmanaged<CFString>?, size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &result) == noErr else { throw DesktopAudioFailure.unavailable }
        guard let result else { throw DesktopAudioFailure.unavailable }
        return result.takeRetainedValue() as String
    }
}
