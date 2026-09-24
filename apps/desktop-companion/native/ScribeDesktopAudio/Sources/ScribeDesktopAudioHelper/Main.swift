import Darwin
@preconcurrency import AVFoundation
import AppKit
import CoreGraphics
import ScribeDesktopAudio

@main
@MainActor
struct ScribeDesktopAudioHelper {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments == ["--availability-v1"] || arguments == ["--request-permissions-v1"]
            || arguments == ["--capture-v2"] else { _exit(64) }
        // This headless helper still uses AppKit/WindowServer through
        // ScreenCaptureKit. Establish its application on the OS main thread
        // and keep that runloop alive across Swift concurrency suspensions.
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        Task { @MainActor in
            await run(arguments)
        }
        application.run()
    }

    private static func run(_ arguments: [String]) async {
        if arguments == ["--availability-v1"] {
            await DesktopAudioProcess.writeAvailability(MacMeetingAudio.permissionsGranted())
            _exit(0)
        }
        if arguments == ["--request-permissions-v1"] {
            await DesktopAudioProcess.writeAvailability(await requestPermissions())
            _exit(0)
        }
        // The packaged main process selects this explicit mode only after its
        // existing fresh capture authority, selection, lease and indicator gate.
        let result = await DesktopAudioProcess.run(source: MacMeetingAudio(enabled: true))
        _exit(result)
    }

    /// Invoked only by the provider's explicit setup action, never by a probe
    /// or capture start. The user decides each normal macOS permission prompt.
    /// No stream, audio engine, selected window or recording authority is created.
    @MainActor
    private static func requestPermissions() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .audio) else { return false }
        default: return false
        }
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        return MacMeetingAudio.permissionsGranted()
    }
}
