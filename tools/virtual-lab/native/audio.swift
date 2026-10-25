import AVFoundation
import CoreAudio
import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import IOKit

// Read-only metadata. This executable cannot open an audio stream or set a route.
enum Failure: Error { case invalid, unavailable, denied }
func hostName() throws -> String {
    // Match Node os.hostname/the owned marker; Foundation may resolve and
    // lowercase the DNS hostname only when network access is available.
    var bytes = [CChar](repeating: 0, count: 512)
    guard gethostname(&bytes, bytes.count) == 0, bytes.contains(0) else { throw Failure.unavailable }
    return String(cString: bytes)
}
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
func hardwareHash() throws -> String {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    guard service != IO_OBJECT_NULL else { throw Failure.unavailable }
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString,
        kCFAllocatorDefault, 0)?.takeRetainedValue() as? String, UUID(uuidString: value) != nil
    else { throw Failure.unavailable }
    return SHA256.hash(data: Data(value.lowercased().utf8)).map { String(format: "%02x", $0) }.joined()
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

// CGSession can be absent in an SSH bootstrap session even while the same
// owned user has an unlocked console. Absence alone never proves unlocked.
func strictBoolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}
func strictUserID(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          ["i", "s", "l", "q", "I", "S", "L", "Q", "c", "C"].contains(String(cString: number.objCType)),
          number.int64Value > 0, number.int64Value <= Int64(UInt32.max) else { return nil }
    return Int(number.int64Value)
}
struct SessionObservation {
    let locked: Bool?
    let source: String
    let reason: String
    var metadata: [String: Any] { ["source": source, "reason": reason] }
}
func sessionObservation(cgLocked: Any?, registry: [String: Any]?, expectedUID: Int,
                        expectedName: String?, consoleUID: Int?) -> SessionObservation {
    func unknown(_ reason: String) -> SessionObservation {
        SessionObservation(locked: nil, source: "unavailable", reason: reason)
    }
    let cg = strictBoolean(cgLocked)
    if cgLocked != nil && cg == nil { return unknown("invalid-cg-lock-value") }
    guard let ioLocked = strictBoolean(registry?["IOConsoleLocked"]) else { return unknown("missing-console-lock") }
    if let cg, cg != ioLocked { return unknown("conflicting-lock-observations") }
    if ioLocked { return SessionObservation(locked: true, source: "io-registry", reason: "console-locked") }
    guard expectedUID > 0, let expectedName, !expectedName.isEmpty, consoleUID == expectedUID
    else { return unknown("console-owner-mismatch") }
    guard let users = registry?["IOConsoleUsers"] as? [[String: Any]], !users.isEmpty, users.count <= 32,
          users.allSatisfy({ strictBoolean($0["kCGSSessionOnConsoleKey"]) != nil })
    else { return unknown("invalid-console-users") }
    let active = users.filter { strictBoolean($0["kCGSSessionOnConsoleKey"]) == true }
    guard active.count == 1, let user = active.first,
          strictUserID(user["kCGSSessionUserIDKey"]) == expectedUID,
          user["kCGSSessionUserNameKey"] as? String == expectedName,
          strictBoolean(user["kCGSessionLoginDoneKey"]) == true
    else { return unknown("console-login-not-matched") }
    return SessionObservation(locked: false,
        source: cg == nil ? "io-registry-and-console-owner" : "cg-session-and-io-registry",
        reason: "owned-console-unlocked")
}
func consoleRegistry() -> [String: Any]? {
    let root = IORegistryGetRootEntry(kIOMainPortDefault)
    guard root != IO_OBJECT_NULL else { return nil }
    defer { IOObjectRelease(root) }
    var properties: Unmanaged<CFMutableDictionary>?
    guard IORegistryEntryCreateCFProperties(root, &properties, kCFAllocatorDefault, 0) == KERN_SUCCESS
    else { return nil }
    return properties?.takeRetainedValue() as? [String: Any]
}
func observeSession() -> SessionObservation {
    let uid = getuid()
    let name = getpwuid(uid).flatMap { $0.pointee.pw_name }.map { String(cString: $0) }
    var info = stat()
    let owner = stat("/dev/console", &info) == 0 ? Int(info.st_uid) : nil
    let cg = CGSessionCopyCurrentDictionary() as? [String: Any]
    return sessionObservation(cgLocked: cg?["CGSSessionScreenIsLocked"], registry: consoleRegistry(),
                              expectedUID: Int(uid), expectedName: name, consoleUID: owner)
}

#if !SCRIBE_LAB_SESSION_TESTS
@main struct AudioInventoryMain {
static func main() {
do {
    guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "inventory" else {
        emit(["passed": false, "reason": "read-only-inventory-required"]); exit(2)
    }
    let config = try json(CommandLine.arguments[2])
    guard let target = config["target"] as? [String: Any], let root = target["root"] as? String,
          let markerPath = target["marker"] as? String, let hostname = target["hostname"] as? String,
          hostname == (try hostName()), let role = target["role"] as? String,
          ["owned-macos-guest", "owned-macos-lab", "owned-ios-simulator"].contains(role) else { throw Failure.invalid }
    let marker = try json(child(markerPath, root).path)
    guard marker["purpose"] as? String == "scribe-synthetic-virtual-lab", marker["hostname"] as? String == hostname,
          marker["role"] as? String == role else { throw Failure.invalid }
    if role == "owned-ios-simulator" {
        guard let udid = target["udid"] as? String, !udid.isEmpty, marker["udid"] as? String == udid else { throw Failure.invalid }
    } else {
        let hardware = try hardwareHash()
        guard let control = target["controlHostHardwareUUIDSHA256"] as? String,
              control.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              control != hardware, marker["hardwareUUIDSHA256"] as? String == hardware
        else { throw Failure.denied }
    }
    let session = observeSession()
    let inventory = try devices()
    emit(["devices": inventory.map { ["uid": $0.1, "name": $0.2] },
          "sessionLocked": session.locked as Any? ?? NSNull(), "sessionEvidence": session.metadata,
          "microphoneAuthorized": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized])
} catch { emit(["passed": false, "reason": "virtual-audio-precondition-failed"]); exit(2) }
}
}
#endif
