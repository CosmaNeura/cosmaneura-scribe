// Test-only stand-in for the audio library. Link the unchanged product Main.swift
// against this module in a cold process; never query permissions or create audio.
import AppKit
import Foundation

public struct MacMeetingAudio: Sendable {
    public let enabled: Bool
    public init(enabled: Bool) { self.enabled = enabled }
    public static func permissionsGranted(microphoneOnly: Bool = false) -> Bool { applicationReady() }
}

public enum MicrophoneCheckProcess {
    @MainActor public static func run() async -> Int32 {
        let ready = applicationReady()
        let bytes = try! JSONSerialization.data(withJSONObject: ["mode": "microphone_check", "application_ready": ready], options: [.sortedKeys])
        FileHandle.standardOutput.write(bytes + Data([10]))
        return ready ? 0 : 70
    }
}

private func applicationReady() -> Bool {
    guard Thread.isMainThread else { return false }
    return MainActor.assumeIsolated {
        NSApp != nil && NSApp.activationPolicy() == .prohibited
    }
}

public enum DesktopAudioProcess {
    public static func writeAvailability(_ available: Bool) async {
        report(["mode": "availability", "application_ready": available])
    }

    public static func run(source: MacMeetingAudio, allowsRenewal: Bool = false) async -> Int32 {
        // Resume from a cooperative worker back onto the application's main
        // thread, the boundary used by the real screen-filter construction.
        let ready = await Task.detached {
            await MainActor.run { applicationReady() }
        }.value
        report(["mode": "capture", "application_ready": ready, "enabled": source.enabled, "allows_renewal": allowsRenewal])
        return ready && source.enabled ? 0 : 70
    }

    private static func report(_ value: [String: Any]) {
        let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
}
