import AppKit
import Darwin
import ScribeDesktopAudio

@main
@MainActor
struct ScribeProviderPresentationHelper {
    static func main() {
#if SCRIBE_MAC_APP_STORE
        guard (try? NativeDesktopStoreContainer.requireContainer()) != nil else { _exit(78) }
#endif
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments == ["--presentation-v1"] || arguments == ["--presentation-v2"] || arguments == ["--presentation-v3"] else { _exit(64) }
        let version = arguments == ["--presentation-v3"] ? 3 : arguments == ["--presentation-v2"] ? 2 : 1
        signal(SIGPIPE, SIG_IGN)
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        Task { @MainActor in
            let result = await ProviderPresentationProcess.run(surface: MacProviderPresentationSurface(), protocolVersion: version)
            _exit(result)
        }
        application.run()
    }
}
