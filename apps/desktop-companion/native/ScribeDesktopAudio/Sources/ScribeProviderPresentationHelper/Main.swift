import AppKit
import Darwin
import ScribeDesktopAudio

@main
@MainActor
struct ScribeProviderPresentationHelper {
    static func main() {
        guard Array(CommandLine.arguments.dropFirst()) == ["--presentation-v1"] else { _exit(64) }
        signal(SIGPIPE, SIG_IGN)
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        Task { @MainActor in
            let result = await ProviderPresentationProcess.run(surface: MacProviderPresentationSurface())
            _exit(result)
        }
        application.run()
    }
}
