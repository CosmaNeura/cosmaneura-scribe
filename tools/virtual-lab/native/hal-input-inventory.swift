// Read-only CoreAudio/libproc metadata. No device setters, streams, taps or audio buffers.
import CoreAudio
import Foundation
import Darwin

enum Failed: Error { case metadata(OSStatus), size, changed, processIdentity }
func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func ids(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) throws -> [AudioObjectID] {
    var a = address(selector, scope), size: UInt32 = 0
    var result = AudioObjectGetPropertyDataSize(object, &a, 0, nil, &size)
    guard result == noErr else { throw Failed.metadata(result) }
    guard size <= 65536, size % 4 == 0 else { throw Failed.size }
    if size == 0 { return [] }
    var values = [AudioObjectID](repeating: 0, count: Int(size / 4)); let expected = size
    result = AudioObjectGetPropertyData(object, &a, 0, nil, &size, &values)
    guard result == noErr else { throw Failed.metadata(result) }
    guard size == expected else { throw Failed.changed }; return values
}
func number(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> UInt32 {
    var a = address(selector), size: UInt32 = 4, value: UInt32 = 0
    let result = AudioObjectGetPropertyData(object, &a, 0, nil, &size, &value)
    guard result == noErr else { throw Failed.metadata(result) }; guard size == 4 else { throw Failed.size }; return value
}
func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var a = address(selector), size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size), value: Unmanaged<CFString>?
    let result = AudioObjectGetPropertyData(object, &a, 0, nil, &size, &value)
    guard result == noErr, let value else { throw Failed.metadata(result) }; return value.takeRetainedValue() as String
}
func identity(_ pid: UInt32) throws -> [String: Any] {
    guard pid > 0, pid <= Int32.max else { throw Failed.processIdentity }
    var info = proc_bsdinfo()
    let expected = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(Int32(pid), PROC_PIDTBSDINFO, 0, &info, expected) == expected,
          info.pbi_pid == pid else { throw Failed.processIdentity }
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN)) // PROC_PIDPATHINFO_MAXSIZE
    guard proc_pidpath(Int32(pid), &path, UInt32(path.count)) > 0 else { throw Failed.processIdentity }
    return ["pid": pid, "parentPid": info.pbi_ppid, "executablePath": String(cString: path),
            "startedAtSeconds": info.pbi_start_tvsec, "startedAtMicroseconds": info.pbi_start_tvusec]
}
func defaultInputUID() throws -> String {
    try string(number(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice), kAudioDevicePropertyDeviceUID)
}
guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == "inspect" else {
    FileHandle.standardError.write(Data("read_only_inspect_mode_required\n".utf8)); exit(2)
}
let serviceBundle = "com.apple.CoreSimulator.SimAudioProcessorServices.SimAudioProcessorService"
var receipt: [String: Any] = ["source":"coreaudio-read-only-process-metadata", "observedAtEpochMs":Date().timeIntervalSince1970 * 1000,
    "audioStreamOpened":false, "deviceMutationIssued":false, "targetDeviceUID":"BlackHole2ch_UID"]
do {
    let inputDefault = try defaultInputUID()
    let first = try ids(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).sorted()
    var entries = [[String: Any]](), errors = [[String: Any]]()
    for object in first {
        do {
            let pid = try number(object, kAudioProcessPropertyPID)
            let inputRunning = try number(object, kAudioProcessPropertyIsRunningInput)
            guard inputRunning <= 1 else { throw Failed.changed }
            let inputDevices = try ids(object, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput)
            let devices = try inputDevices.map { id in
                let transport = try number(id, kAudioDevicePropertyTransportType)
                return ["objectId":id, "uid":try string(id, kAudioDevicePropertyDeviceUID), "transportType":transport,
                        "isAggregate": transport == kAudioDeviceTransportTypeAggregate] as [String:Any]
            }
            let bundle = try string(object, kAudioProcessPropertyBundleID)
            let beforeIdentity = inputRunning != 0 || bundle == serviceBundle ? try identity(pid) : nil
            let afterPid = try number(object, kAudioProcessPropertyPID)
            let afterRunning = try number(object, kAudioProcessPropertyIsRunningInput)
            let afterDevices = try ids(object, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput)
            let afterIdentity = beforeIdentity == nil ? nil : try identity(afterPid)
            guard pid == afterPid, inputRunning == afterRunning, inputDevices == afterDevices,
                  beforeIdentity == nil || NSDictionary(dictionary: beforeIdentity!).isEqual(to: afterIdentity!)
            else { throw Failed.changed }
            entries.append(["processObjectId":object, "pid":pid, "bundleId":bundle, "processIdentity": beforeIdentity ?? NSNull(),
                "runningInput":inputRunning != 0, "inputDevices":devices,
                "usesTargetInput":devices.contains { $0["uid"] as? String == "BlackHole2ch_UID" }])
        } catch { errors.append(["processObjectId":object, "reason":String(describing:error)]) }
    }
    let last = try ids(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).sorted()
    let defaultsStable = inputDefault == (try defaultInputUID())
    receipt["defaultInputDeviceUID"] = inputDefault; receipt["defaultInputStable"] = defaultsStable
    receipt["processListStable"] = first == last; receipt["processes"] = entries; receipt["errors"] = errors
    receipt["processListNonempty"] = !first.isEmpty
    receipt["completeSnapshot"] = first == last && defaultsStable && errors.isEmpty && !first.isEmpty
    receipt["activeTargetInputClients"] = entries.filter { $0["runningInput"] as? Bool == true && $0["usesTargetInput"] as? Bool == true }
    receipt["limitation"] = "Point-in-time HAL metadata; not an exclusivity guarantee against a client starting after the read."
} catch { receipt["completeSnapshot"] = false; receipt["failure"] = String(describing:error) }
receipt["completedAtEpochMs"] = Date().timeIntervalSince1970 * 1000
let bytes = try JSONSerialization.data(withJSONObject:receipt, options:[.prettyPrinted,.sortedKeys])
FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
