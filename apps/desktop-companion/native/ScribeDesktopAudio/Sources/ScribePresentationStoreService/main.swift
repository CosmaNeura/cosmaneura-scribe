import Darwin
#if SCRIBE_MAC_APP_STORE_XPC
import ScribeStorePipe
import ScribeStoreWorkers
#endif
@main struct ScribePresentationStoreService {
    @MainActor static func main() {
#if SCRIBE_MAC_APP_STORE_XPC
        NativeStoreWorkerService.run(role: SCRIBE_PRESENTATION)
#else
        _exit(78)
#endif
    }
}
