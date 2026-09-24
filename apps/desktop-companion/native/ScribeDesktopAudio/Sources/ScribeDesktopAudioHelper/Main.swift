import Darwin
import ScribeDesktopAudio

@main
struct ScribeDesktopAudioHelper {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--availability-v1"] {
            await DesktopAudioProcess.writeAvailability(MacMeetingAudio.permissionsGranted())
            _exit(0)
        }
        guard arguments == ["--capture-v2"] else { _exit(64) }
        // The packaged main process selects this explicit mode only after its
        // existing fresh capture authority, selection, lease and indicator gate.
        let result = await DesktopAudioProcess.run(source: MacMeetingAudio(enabled: true))
        _exit(result)
    }
}
