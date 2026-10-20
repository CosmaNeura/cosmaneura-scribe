#if os(macOS)
import AppKit
import CosmasNativeAuth
import Foundation
#if SCRIBE_MAC_APP_STORE_XPC
import Darwin
import ScribeStorePipe
#endif

/// Bundled native identity and provider HTTP owner. Inherited pipes are its only
/// command surface; endpoints/settings are fixed bundle inputs, never arguments.
@MainActor private final class DesktopProviderOwner {
    private let auth: NativeWorkspaceAuth
    private let connection: NativeProviderConnection
    private let window: NSWindow
    private var active: Set<String> = []
    private var sources = DesktopSourceRegistry()
    private var recovery: NativeSourceRecovery?
#if SCRIBE_MAC_APP_STORE_XPC
    private let storeOutput: FileHandle
    private let storeClosed: (() -> Void)?
    private var storeFinished = false
#endif

    init(output: FileHandle = .standardOutput, onClose: (() -> Void)? = nil) throws {
#if SCRIBE_MAC_APP_STORE_XPC
        storeOutput = output; storeClosed = onClose
#endif
#if SCRIBE_MAC_APP_STORE || SCRIBE_MAC_APP_STORE_XPC
        _ = try NativeDesktopStoreContainer.requireContainer()
#endif
        guard Bundle.main.bundleIdentifier == NativeClerkConfiguration.desktopBundleIdentifier,
              let settings = Bundle.main.object(forInfoDictionaryKey: "CosmasNativeAuth") as? [String: Any],
              let receiver = Bundle.main.object(forInfoDictionaryKey: "ScribeProviderReceiver") as? [String: Any]
        else { throw ProviderNativeError.unavailable }
        if settings["enabled"] as? Bool == true {
            guard let key = settings["publishableKey"] as? String,
                  let origin = settings["frontendOrigin"] as? String,
                  settings["identityProfile"] as? String == NativeIdentityProfile.coreStagingPersonal.rawValue,
                  settings["organizationId"] == nil, settings["audience"] == nil else {
                throw ProviderNativeError.unavailable
            }
            let config = try NativeClerkConfiguration(publishableKey: key, frontendOrigin: origin,
                organizationID: nil, bundleIdentifier: NativeClerkConfiguration.desktopBundleIdentifier,
                workspaceOrigin: .desktopApp, identityProfile: .coreStagingPersonal)
            let policy = try NativeTokenPolicy(issuer: origin, audience: nil,
                authorizedParty: NativeWorkspaceOrigin.desktopApp.rawValue,
                identityProfile: .coreStagingPersonal)
#if SCRIBE_MAC_APP_STORE_XPC
            // Signed Store membership was checked before this point. Its auth
            // identity, credential group and source container are distinct from
            // the direct app; no old marker or owner folder is consulted.
            let journal = try NativeSourceProofJournal(platform: .desktop,
                backing: KeychainNativeSourceJournal(platform: .desktop,
                    bundleIdentifier: config.bundleIdentifier))
            let storeRecovery = NativeSourceRecovery(journal: journal,
                desktopDirectory: try nativeDesktopFenceDirectory())
            try storeRecovery.prepareStoreBeforeAuthentication()
            recovery = storeRecovery
#endif
            auth = NativeWorkspaceAuth(enabled: true, organizationID: nil, tokenPolicy: policy,
                driver: { try ClerkKitWorkspaceDriver(configuration: config) },
                accessBlock: { try KeychainAccessBlock(bundleIdentifier: config.bundleIdentifier) })
        } else {
            auth = NativeWorkspaceAuth(enabled: false, organizationID: nil,
                driver: { throw NativeAuthError.unavailable },
                accessBlock: { throw NativeAuthError.unavailable })
        }
        connection = NativeProviderConnection(auth: auth,
            wire: try ProviderNativeTransport(settings: receiver, workspaceOrigin: .desktopApp),
            desktopInitialWindowEnabled: true, desktopVisitSignInEnabled: true, setupVisitSignInEnabled: true)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 160),
                          styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Sign in to Scribe"; window.center(); window.orderOut(nil)
        auth.onChange = { [weak self] state in
            guard let self else { return }
            self.connection.authChanged(state)
            self.sources.retireForAuthenticationChange()
            self.write(["event": "authStateChanged", "state": self.state(state)])
        }
    }

    func receive(_ data: Data) async {
#if SCRIBE_MAC_APP_STORE_XPC
        guard !storeFinished, !Task.isCancelled else { return }
#endif
        var id: String?
        do {
            guard data.count <= 16 * 1024 * 1024,
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(value.keys) == ["id", "method", "payload"],
                  let requestID = value["id"] as? String,
                  UUID(uuidString: requestID)?.uuidString.lowercased() == requestID,
                  let method = value["method"] as? String,
                  let payload = value["payload"] as? [String: Any],
                  !active.contains(requestID), active.count < 8 else {
                throw ProviderNativeError.invalidRequest
            }
            id = requestID; active.insert(requestID)
            defer { active.remove(requestID) }
            let result = try await run(method, payload: payload, id: requestID)
            write(["id": requestID, "ok": true, "result": result])
        } catch {
            if let id { write(["id": id, "ok": false, "result": NSNull()]) }
            else { close() }
        }
    }

    private func run(_ method: String, payload: [String: Any], id: String) async throws -> Any {
        switch method {
        case "getState", "signIn", "signOut":
            guard payload.isEmpty else { throw ProviderNativeError.invalidRequest }
            if method == "signIn" {
                window.makeKeyAndOrderFront(nil); NSApplication.shared.activate(ignoringOtherApps: true)
                defer { window.orderOut(nil) }
                return self.state(try await auth.signIn())
            }
            if method == "signOut" { return self.state(try await auth.signOut()) }
            return self.state(auth.state())
        case "prepareProviderSignIn":
            guard Set(payload.keys) == ["preparationId", "revision", "workspaceId", "bindingRef"],
                  let preparation = payload["preparationId"] as? String, let revision = payload["revision"] as? String,
                  let workspace = payload["workspaceId"] as? String, let binding = payload["bindingRef"] as? String
            else { throw ProviderNativeError.invalidRequest }
            try connection.prepareVisitSignIn(revision: revision, workspaceID: workspace,
                bindingRef: binding, preparationID: preparation)
            return ["revision": revision]
        case "abandonProviderSignIn":
            guard Set(payload.keys) == ["preparationId"], let preparation = payload["preparationId"] as? String
            else { throw ProviderNativeError.invalidRequest }
            try connection.abandonVisitSignIn(preparationID: preparation)
            return NSNull()
        case "providerRequest":
            guard Set(payload.keys) == ["revision", "action", "key", "body"],
                  let revision = payload["revision"] as? String,
                  let action = payload["action"] as? String,
                  let key = payload["key"] as? String, let body = payload["body"] as? String else {
                throw ProviderNativeError.invalidRequest
            }
            let request = try ProviderNativeRequest(id: id, revision: revision, action: action, key: key, body: body)
            try await recoverSources()
            let reply = try await connection.send(request)
            guard let json = String(data: reply.body, encoding: .utf8) else { throw ProviderNativeError.response }
            return ["status": reply.status, "body": json]
        case "providerInitialWindow":
            guard Set(payload.keys) == ["revision", "key", "body", "admissionKey", "admissionNonce", "admissionReceipt"],
                  let revision = payload["revision"] as? String, let key = payload["key"] as? String,
                  let body = payload["body"] as? String, let admissionKey = payload["admissionKey"] as? String,
                  let admissionNonce = payload["admissionNonce"] as? String,
                  let receipt = payload["admissionReceipt"] as? [String: Any] else {
                throw ProviderNativeError.invalidRequest
            }
            let receiptData = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys, .withoutEscapingSlashes])
            guard receiptData.count <= 8192 else { throw ProviderNativeError.invalidRequest }
            let request = try ProviderNativeRequest(id: id, revision: revision, action: "capture-operations", key: key, body: body)
            let reply = try await connection.sendFreshDesktopInitialWindow(request, admissionKey: admissionKey,
                admissionNonce: admissionNonce, admissionReceipt: receiptData, beforeDispatch: { try await self.recoverSources() })
            guard let json = String(data: reply.body, encoding: .utf8) else { throw ProviderNativeError.response }
            return ["status": reply.status, "body": json]
        case "providerInitialWindowAbandon":
            guard payload.isEmpty else { throw ProviderNativeError.invalidRequest }
            connection.abandonDesktopInitialWindow()
            return NSNull()
        case "sourcePrepare", "sourcePrepareForStart":
            guard Set(payload.keys.filter { $0 != "firstSequenceNumber" }) == ["revision", "preparationId", "workspaceId", "bindingRef", "sessionId",
                "leaseId", "leaseReceiptId", "leaseGeneration", "captureAuthorizedUntil"],
                  let revision = payload["revision"] as? String,
                  auth.state().phase == .ready, auth.state().revision == revision,
                  let identity = auth.state().identity,
                  let binding = payload["bindingRef"] as? String,
                  let generation = payload["leaseGeneration"] as? NSNumber,
                  CFGetTypeID(generation) != CFBooleanGetTypeID(),
                  generation.doubleValue.rounded(.down) == generation.doubleValue,
                  generation.doubleValue > 0, generation.doubleValue < 2_147_483_648,
                  let deadline = payload["captureAuthorizedUntil"] as? String else {
                throw ProviderNativeError.invalidRequest
            }
            try await recoverSources()
            guard auth.state().phase == .ready, auth.state().revision == revision, let recovery else {
                throw ProviderNativeError.unavailable
            }
            try recovery.requireReady()
            let session = try Self.uuid(payload["sessionId"])
            let preparation = try NativeSourcePreparation(workspaceID: Self.uuid(payload["workspaceId"]),
                bindingRef: binding, sessionID: session, leaseID: Self.uuid(payload["leaseId"]),
                leaseReceiptID: Self.uuid(payload["leaseReceiptId"]), leaseGeneration: generation.intValue,
                captureAuthorizedUntil: deadline, source: .desktop,
                firstSequenceNumber: nativeSourceFirstSequence(payload["firstSequenceNumber"]))
            let grant = try await sources.prepare(id: Self.uuid(payload["preparationId"]), preparation: preparation,
                forStart: method == "sourcePrepareForStart") {
                try NativeSourceStartOwner(connection: connection, revision: revision,
                    preparation: preparation, identity: identity, journal: recovery.journal, stopRevision: { [connection] in try connection.stopRevision(for: identity) })
            }
            guard auth.state().phase == .ready, auth.state().revision == revision else {
                throw ProviderNativeError.unavailable
            }
            return ["grant": grant.desktopPayload, "processFence": try recovery.processFence]
        case "sourcePreparationRelease":
            guard Set(payload.keys) == ["revision", "preparationId"],
                  let revision = payload["revision"] as? String,
                  UUID(uuidString: revision)?.uuidString.lowercased() == revision else {
                throw ProviderNativeError.invalidRequest
            }
            // Correlation survives the old auth revision. Its native owner
            // authorizes cessation only after fresh same-account authentication.
            try await sources.releasePreparation(id: Self.uuid(payload["preparationId"]))
            return NSNull()
        case "sourceAuthorize", "sourceRelease", "sourceStopped":
            guard Set(payload.keys) == ["sourceLeaseId"],
                  let start = payload["sourceLeaseId"] as? String,
                  UUID(uuidString: start)?.uuidString.lowercased() == start else {
                throw ProviderNativeError.invalidRequest
            }
            if method == "sourceAuthorize" { return try await sources.authorize(sourceLeaseID: start).desktopPayload }
            // Only the trusted main recorder may send sourceStopped after its
            // native stop barrier. Generic disposal can cancel preparation only.
            try await sources.release(sourceLeaseID: start, stopped: method == "sourceStopped")
            return NSNull()
        default: throw ProviderNativeError.invalidRequest
        }
    }

    private func recoverSources() async throws {
        if recovery == nil {
            let journal = try NativeSourceProofJournal(platform: .desktop,
                backing: KeychainNativeSourceJournal(platform: .desktop,
                    bundleIdentifier: Bundle.main.bundleIdentifier ?? ""))
            recovery = NativeSourceRecovery(journal: journal, desktopDirectory: try nativeDesktopFenceDirectory())
        }
        guard let recovery else { throw ProviderNativeError.unavailable }
        try await recovery.recover(connection: connection)
    }

    func close() {
#if SCRIBE_MAC_APP_STORE_XPC
        guard !storeFinished else { return }
        storeFinished = true
#endif
        connection.close()
#if SCRIBE_MAC_APP_STORE_XPC
        sources.close(); window.orderOut(nil); storeClosed?()
#else
        sources.close(); NSApplication.shared.terminate(nil)
#endif
    }

    private static func uuid(_ value: Any?) throws -> UUID {
        guard let string = value as? String, let id = UUID(uuidString: string),
              id.uuidString.lowercased() == string else { throw ProviderNativeError.invalidRequest }
        return id
    }
    private func state(_ value: NativeAuthState) -> [String: Any] {
        var payload: [String: Any] = ["phase": value.phase.rawValue, "revision": value.revision]
        if value.phase == .ready { payload["recordingSignInPreparationVersion"] = 1 }
        if let name = auth.providerDisplayName(expectedRevision: value.revision) {
            payload["providerDisplayName"] = name
        }
        return payload
    }
    private func write(_ value: [String: Any]) {
#if SCRIBE_MAC_APP_STORE_XPC
        guard !storeFinished else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: value)
            guard data.count <= 2 * (32 * 1024 * 1024 + 16_384) + 8192 else { throw ProviderNativeError.response }
            data.append(10); try storeOutput.write(contentsOf: data)
        } catch { close() }
#else
        Self.write(value)
#endif
    }
#if !SCRIBE_MAC_APP_STORE_XPC
    private static func write(_ value: [String: Any]) {
        do {
            var data = try JSONSerialization.data(withJSONObject: value)
            // Core JSON is nested in a JSON string, allowing at most twofold escaping.
            guard data.count <= 2 * (32 * 1024 * 1024 + 16_384) + 8192 else { throw ProviderNativeError.response }
            data.append(10); try FileHandle.standardOutput.write(contentsOf: data)
        } catch { NSApplication.shared.terminate(nil) }
    }
#endif
}

#if SCRIBE_MAC_APP_STORE_XPC
/// The C service retains its originals. This snapshot owns only explicit dup
/// descriptors and a retained completion block across the asynchronous hop.
private final class DesktopProviderStoreRequest: @unchecked Sendable {
    let sourceInput: Int32
    let input: DesktopProviderStoreInput
    let output: FileHandle
    let completed: scribe_store_completion

    init(_ request: UnsafePointer<scribe_store_open>, completed: @escaping scribe_store_completion) throws {
        guard let mode = request.pointee.mode, String(cString: mode) == "--provider-v1",
              request.pointee.host > 1 else { throw ProviderNativeError.unavailable }
        sourceInput = request.pointee.input
        input = try DesktopProviderStoreInput(duplicating: request.pointee.input)
        let descriptor = Darwin.dup(request.pointee.output)
        guard descriptor >= 0 else { throw ProviderNativeError.unavailable }
        guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 else {
            Darwin.close(descriptor); throw ProviderNativeError.unavailable
        }
        output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        self.completed = completed
    }
}

@MainActor private final class DesktopProviderStoreSession {
    private var request: DesktopProviderStoreRequest?
    private var owner: DesktopProviderOwner?
    private var operations: [UUID: Task<Void, Never>] = [:]
    private var stopped = false
    private var stoppedInputs: Set<Int32> = []
    private var readerDone = false
    private var result: Int32 = 0

    func start(_ request: DesktopProviderStoreRequest) {
        guard !stopped, !stoppedInputs.contains(request.sourceInput), self.request == nil else { request.completed(70); return }
        self.request = request
        do {
            owner = try DesktopProviderOwner(output: request.output, onClose: { [weak self] in self?.stop() })
        } catch { readerDone = true; stop(code: 78); return }
        DispatchQueue.global(qos: .userInitiated).async {
            let code = request.input.readFrames { frame in
                // Bound delivery to one pending main-actor frame; the native
                // owner retains its existing eight-operation admission limit.
                let delivered = DispatchSemaphore(value: 0)
                Task { @MainActor in self.receive(frame); delivered.signal() }
                delivered.wait()
            }
            Task { @MainActor in self.readerFinished(code: code) }
        }
    }

    private func receive(_ frame: Data) {
        guard !stopped, let owner else { return }
        guard operations.count < 8 else { stop(); return }
        let id = UUID()
        operations[id] = Task { @MainActor in
            await owner.receive(frame)
            self.operations.removeValue(forKey: id)
            self.finishIfDrained()
        }
    }

    func stop(input: Int32) {
        guard let request else { stoppedInputs.insert(input); return }
        guard request.sourceInput == input else { return }
        stop()
    }

    func stop(code: Int32 = 70) {
        guard !stopped else { return }
        stopped = true; result = code
        request?.input.stop()
        owner?.close()
        for operation in operations.values { operation.cancel() }
        finishIfDrained()
    }

    private func readerFinished(code: Int32) { readerDone = true; stop(code: code); finishIfDrained() }
    private func finishIfDrained() {
        guard stopped, readerDone, operations.isEmpty, let request else { return }
        self.request = nil; owner = nil
        do { try request.output.close() } catch { result = 70 }
        request.completed(result)
    }
}

@main private struct DesktopProviderMain {
    @MainActor static func main() {
        do {
            _ = try NativeDesktopStoreContainer.requireContainer()
            guard let service = Bundle.main.object(forInfoDictionaryKey: "XPCService") as? [String: Any],
                  service["JoinExistingSession"] as? Bool == true,
                  service["RunLoopType"] as? String == "NSRunLoop" else { return }
            NSApplication.shared.setActivationPolicy(.accessory)
            let session = DesktopProviderStoreSession()
            _ = scribe_store_service_run(SCRIBE_AUTH, { request, completed in
                guard let request, let completed else { return }
                do {
                    let retained = try DesktopProviderStoreRequest(request, completed: completed)
                    Task { @MainActor in session.start(retained) }
                } catch { completed(78) }
            }, { open in
                guard let open else { return }
                let input = open.pointee.input
                Task { @MainActor in session.stop(input: input) }
            })
            // xpc_main drives the documented NSRunLoop service mode; do not run
            // a competing NSApplication loop or terminate the service from UI.
        } catch { /* Missing membership cannot create an auth owner. */ }
    }
}
#else
@main private struct DesktopProviderMain {
    @MainActor static func main() {
        guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--provider-v1" else { return }
        NSApplication.shared.setActivationPolicy(.accessory)
        do {
            let owner = try DesktopProviderOwner()
            DispatchQueue.global(qos: .userInitiated).async {
                DesktopProviderInput.readFrames { frame in
                    Task { @MainActor in await owner.receive(frame) }
                }
                Task { @MainActor in owner.close() }
            }
            NSApplication.shared.run()
        } catch { /* Invalid/disabled bundle inputs cannot create a fallback identity. */ }
    }
}
#endif
#endif
