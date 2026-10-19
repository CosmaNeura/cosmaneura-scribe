#if SCRIBE_MAC_APP_STORE_XPC
import AppKit
@preconcurrency import AVFoundation
import CoreGraphics
import Darwin
import Foundation
import ScribeDesktopAudio
@preconcurrency import ScribeStorePipe

private final class StoreWorkerRequest: @unchecked Sendable {
    let mode: String, host: Int32, descriptor: Int32
    let input: FileHandle, output: FileHandle
    let completed: scribe_store_completion
    let lifetime = NativeProcessLifetime()
    init(_ open: UnsafePointer<scribe_store_open>, completed: @escaping scribe_store_completion) {
        mode = String(cString: open.pointee.mode)
        host = open.pointee.host; descriptor = open.pointee.input
        input = FileHandle(fileDescriptor: open.pointee.input, closeOnDealloc: false)
        output = FileHandle(fileDescriptor: open.pointee.output, closeOnDealloc: false)
        self.completed = completed
    }
}

/// Registration/cancellation happens synchronously on the C listener callback,
/// before any main-actor hop. A late completion cannot cancel a reused numeric FD.
private final class StoreWorkerRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var workers: [Int32: NativeProcessLifetime] = [:]
    func register(_ request: StoreWorkerRequest) -> Bool {
        lock.withLock {
            guard workers[request.descriptor] == nil else { return false }
            workers[request.descriptor] = request.lifetime; return true
        }
    }
    func stop(_ descriptor: Int32) {
        let lifetime = lock.withLock { workers[descriptor] }
        lifetime?.cancel()
    }
    func complete(_ request: StoreWorkerRequest) {
        lock.withLock {
            if workers[request.descriptor] === request.lifetime { workers.removeValue(forKey: request.descriptor) }
        }
    }
}

@MainActor private final class StoreWorkerSessions {
    private let role: scribe_store_role
    private let registry: StoreWorkerRegistry
    init(role: scribe_store_role, registry: StoreWorkerRegistry) { self.role = role; self.registry = registry }
    func start(_ request: StoreWorkerRequest) {
        Task { @MainActor in
            let result = await self.perform(request, lifetime: request.lifetime)
            request.lifetime.finishReading()
            self.registry.complete(request)
            request.completed(result)
        }
    }
    private func perform(_ request: StoreWorkerRequest, lifetime: NativeProcessLifetime) async -> Int32 {
        guard !lifetime.isCancelled else { return 70 }
        if role == SCRIBE_PRESENTATION {
            guard ["--presentation-v1", "--presentation-v2", "--presentation-v3"].contains(request.mode),
                  let host = try? NativeStoreHostIdentity(authenticatedProcess: request.host) else { return 78 }
            let version = request.mode == "--presentation-v3" ? 3 : request.mode == "--presentation-v2" ? 2 : 1
            return await ProviderPresentationProcess.run(surface: MacProviderPresentationSurface(storeHost: host),
                input: request.input, output: request.output, protocolVersion: version, lifetime: lifetime)
        }
        guard role == SCRIBE_AUDIO else { return 78 }
        switch request.mode {
        case "--microphone-check-v1":
            return await MicrophoneCheckProcess.run(input: request.input, output: request.output, lifetime: lifetime)
        case "--availability-v1", "--microphone-availability-v1":
            let written = await DesktopAudioProcess.writeAvailabilityResult(MacMeetingAudio.permissionsGranted(microphoneOnly: request.mode == "--microphone-availability-v1"), output: request.output)
            return lifetime.isCancelled || !written ? 70 : 0
        case "--request-permissions-v1", "--microphone-permissions-v1":
            let available = await requestPermissions(microphoneOnly: request.mode == "--microphone-permissions-v1")
            guard !lifetime.isCancelled else { return 70 }
            let written = await DesktopAudioProcess.writeAvailabilityResult(available, output: request.output)
            return lifetime.isCancelled || !written ? 70 : 0
        case "--capture-v2", "--capture-v3":
            // The inherited bridge forwards the existing authorized capture pipe;
            // XPC admission and this mode never create or widen capture authority.
            return await DesktopAudioProcess.run(source: MacMeetingAudio(enabled: true), allowsRenewal: request.mode == "--capture-v3",
                input: request.input, output: request.output, lifetime: lifetime)
        default: return 64
        }
    }
    private func requestPermissions(microphoneOnly: Bool) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined: guard await AVCaptureDevice.requestAccess(for: .audio) else { return false }
        default: return false
        }
        if !microphoneOnly && !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        return MacMeetingAudio.permissionsGranted(microphoneOnly: microphoneOnly)
    }
}

@MainActor public enum NativeStoreWorkerService {
    public static func run(role: scribe_store_role) -> Never {
        guard role == SCRIBE_AUDIO || role == SCRIBE_PRESENTATION,
              (try? NativeDesktopStoreContainer.requireContainer()) != nil,
              let service = Bundle.main.object(forInfoDictionaryKey: "XPCService") as? [String: Any],
              service["ServiceType"] as? String == "Application", service["RunLoopType"] as? String == "NSRunLoop",
              service["JoinExistingSession"] as? Bool == true else { _exit(78) }
        signal(SIGPIPE, SIG_IGN)
        NSApplication.shared.setActivationPolicy(role == SCRIBE_AUDIO ? .prohibited : .accessory)
        let registry = StoreWorkerRegistry()
        let sessions = StoreWorkerSessions(role: role, registry: registry)
        let result = scribe_store_service_run(role, { open, completed in
            guard let open, let completed else { return }
            let request = StoreWorkerRequest(open, completed: completed)
            guard registry.register(request) else { completed(70); return }
            Task { @MainActor in sessions.start(request) }
        }, { open in
            guard let open else { return }
            let descriptor = open.pointee.input
            registry.stop(descriptor)
        })
        _exit(Int32(result))
    }
}
#endif
