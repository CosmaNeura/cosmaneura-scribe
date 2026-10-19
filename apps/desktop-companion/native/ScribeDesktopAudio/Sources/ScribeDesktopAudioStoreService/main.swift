import Darwin
#if SCRIBE_MAC_APP_STORE_XPC
import ScribeStorePipe
import ScribeStoreWorkers
#endif
@main struct ScribeDesktopAudioStoreService {
    @MainActor static func main() {
#if SCRIBE_MAC_APP_STORE_XPC
        NativeStoreWorkerService.run(role: SCRIBE_AUDIO)
#else
        _exit(78)
#endif
    }
}
