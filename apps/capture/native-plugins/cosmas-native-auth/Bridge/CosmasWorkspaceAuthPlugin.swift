@preconcurrency import Capacitor
import CosmasNativeAuth
import CosmaneuraNativeRecording
import Foundation
import CoreFoundation
#if os(iOS)
import AVFAudio
#endif

@objc(CosmasWorkspaceAuthPlugin)
@MainActor
public final class CosmasWorkspaceAuthPlugin: CAPPlugin, @preconcurrency CAPBridgedPlugin, @unchecked Sendable {
    // Capacitor's Objective-C superclass has no Sendable annotations. Entry
    // points below only enqueue MainActor work; all app-owned mutable state,
    // SDK calls, listener notifications and response completion stay there.
    public let identifier = "CosmasWorkspaceAuthPlugin"
    public let jsName = "CosmasWorkspaceAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProviderState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProviderActiveRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeRecordingOpenRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "providerRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordProviderReadyTiming", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelProviderRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareProviderSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abandonProviderSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareProviderSource", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeProviderSource", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openProviderRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "providerRecordingCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playProviderPassage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readProviderPassage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopProviderPassage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProviderConfiguration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openProviderCore", returnType: CAPPluginReturnPromise),


    ]

    private var auth: NativeWorkspaceAuth?
    private var providerConnection: NativeProviderConnection?
    private var sourceRecovery: NativeSourceRecovery?
    private var providerSourceOwner: NativeSourceStartOwner?
    private var providerSourcePreparation: NativeSourcePreparation?
    private var providerSourceRevision: String?
    private var providerSourceID: UUID?
    private var observedDriver: W13ObservedAuthDriver?
    private static let recordingBridge = NativeProviderRecordingBridge()
    private static let passagePlayback = NativePassagePlayback()
    private static var passageRevision: String?
    private var passageObservations: [RecordingOpenObservation] = []
    private var recordingOpenObservation: RecordingOpenObservation?
    private var recordingOpenPending = false

    nonisolated public override func load() {
        Task { @MainActor in self.initializeAuth(); self.observeRecordingLinks(); self.observePassageLifecycle() }
    }

    private func observeRecordingLinks() {
        #if os(iOS)
        guard recordingOpenObservation == nil else { return }
        let token = NotificationCenter.default.addObserver(forName: .capacitorOpenURL,
            object: nil, queue: .main) { [weak self] notification in
            let value = (notification.object as? [String: Any])?["url"] as? URL
            guard value?.absoluteString == "scribe-recording://recording" else { return }
            Task { @MainActor [weak self] in
                self?.recordingOpenPending = true
                self?.notifyListeners("recordingOpen", data: ["version": 1])
            }
        }
        recordingOpenObservation = RecordingOpenObservation(token)
        #endif
    }

    @objc nonisolated public func takeRecordingOpenRequest(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.isEmpty else { return Self.rejectProvider(call) }
            let pending = self.recordingOpenPending
            self.recordingOpenPending = false
            call.resolve(["version": 1, "pending": pending])
        }
    }

    @objc nonisolated public func getProviderActiveRecording(_ call: CAPPluginCall) {
        Task { @MainActor in
            self.initializeAuth()
            guard Set(call.options.keys) == ["revision"], let revision = call.getString("revision"),
                UUID(uuidString: revision)?.uuidString.lowercased() == revision,
                self.nativeRecordingAvailable, let auth = self.auth,
                auth.state().phase == .ready, auth.state().revision == revision
            else { return Self.rejectProvider(call) }
            call.resolve(["version": 1, "revision": revision,
                "recording": Self.recordingBridge.navigationMetadata(revision: revision) as Any? ?? NSNull()])
        }
    }

    @MainActor private func initializeAuth() {
        guard auth == nil else { return }
        let settings = Bundle.main.object(forInfoDictionaryKey: "CosmasNativeAuth") as? [String: Any] ?? [:]
        if settings["enabled"] as? Bool != true {
            auth = NativeWorkspaceAuth(enabled: false, organizationID: "",
                driver: { throw NativeAuthError.unavailable }, accessBlock: { throw NativeAuthError.unavailable })
        } else {
            do {
                guard let key = settings["publishableKey"] as? String,
                      let origin = settings["frontendOrigin"] as? String,
                      let bundle = Bundle.main.bundleIdentifier else { throw NativeAuthError.unavailable }
                let profileName = settings["identityProfile"] as? String
                    ?? NativeIdentityProfile.clerkOrganization.rawValue
                guard let profile = NativeIdentityProfile(rawValue: profileName) else { throw NativeAuthError.unavailable }
                let organization = settings["organizationId"] as? String
                let audience = settings["audience"] as? String
                if profile == .coreStagingPersonal &&
                    (settings["organizationId"] != nil || settings["audience"] != nil) {
                    throw NativeAuthError.unavailable
                }
                let configuration = try NativeClerkConfiguration(publishableKey: key, frontendOrigin: origin,
                    organizationID: organization, bundleIdentifier: bundle, identityProfile: profile,
                    sessionClaimsReceiptSHA256: settings["sessionClaimsReceiptSha256"] as? String,
                    nativePolicyReceiptSHA256: settings["nativePolicyReceiptSha256"] as? String)
                let policy = try NativeTokenPolicy(issuer: origin, audience: audience, identityProfile: profile,
                    productionNativePolicyReceiptSHA256: configuration.nativePolicyReceiptSHA256)
                auth = NativeWorkspaceAuth(enabled: true, organizationID: organization, tokenPolicy: policy,
                    driver: {
                        let driver = W13ObservedAuthDriver(
                            base: try ClerkKitWorkspaceDriver(configuration: configuration), policy: policy)
                        self.observedDriver = driver
                        return driver
                    },
                    accessBlock: { try KeychainAccessBlock(bundleIdentifier: bundle) })
            } catch {
                auth = NativeWorkspaceAuth(enabled: true, organizationID: "",
                    driver: { throw NativeAuthError.unavailable }, accessBlock: { throw NativeAuthError.unavailable })
            }
        }
        auth?.onChange = { [weak self] state in
            if state.phase != .ready || state.revision != Self.passageRevision { Self.passagePlayback.stopAll() }
            Self.recordingBridge.authChanged(state)
            self?.providerConnection?.authChanged(state)
            if state.phase != .ready || self?.providerSourceRevision != state.revision {
                self?.invalidateProviderSource()
            }
            self?.notifyListeners("authStateChanged", data: Self.payload(state))
        }
    }

    @objc nonisolated public func getState(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.isEmpty else { return Self.reject(call) }
            self.initializeAuth()
            guard let auth = self.auth else { return Self.reject(call) }
            call.resolve(Self.payload(auth.state()))
        }
    }

    @objc nonisolated public func signIn(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.isEmpty else { return Self.reject(call) }
            self.initializeAuth()
            do {
                guard let auth = self.auth else { throw NativeAuthError.unavailable }
                call.resolve(Self.payload(try await auth.signIn()))
            } catch { Self.reject(call) }
        }
    }

    @objc nonisolated public func signOut(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.isEmpty else { return Self.reject(call) }
            self.initializeAuth()
            do {
                guard let auth = self.auth else { throw NativeAuthError.unavailable }
                call.resolve(Self.payload(try await auth.signOut()))
            } catch { Self.reject(call) }
        }
    }

    @objc nonisolated public func getToken(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.count == 1, let revision = call.getString("expectedRevision"),
                  UUID(uuidString: revision)?.uuidString.lowercased() == revision else { return Self.reject(call) }
            self.initializeAuth()
            do {
                guard let auth = self.auth else { throw NativeAuthError.unavailable }
                let token = try await auth.token(expectedRevision: revision)
                call.resolve(["token": token, "revision": revision])
            } catch { Self.reject(call) }
        }
    }

    @objc nonisolated public func getWorkspaceCatalog(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.count == 1, let revision = call.getString("expectedRevision"),
                  UUID(uuidString: revision)?.uuidString.lowercased() == revision else { return Self.reject(call) }
            self.initializeAuth()
            guard let auth = self.auth, auth.state().phase == .ready,
                  auth.state().revision == revision else { return Self.reject(call) }
            do {
                guard let settings = Bundle.main.object(forInfoDictionaryKey: "W13PrivateWorkspace") as? [String: Any]
                else { throw W13ConnectionError.configuration }
                let transport = try W13PrivateTransport(settings: settings)
                // Check the private TLS route before requesting a credential.
                _ = try await transport.read(path: "/connection")
                guard auth.state().revision == revision else { return Self.reject(call) }
                let token: String
                let observation = self.observedDriver?.beginObservation()
                do { token = try await auth.token(expectedRevision: revision, nativeSessionWithoutOrigin: true) }
                catch {
                    call.reject("Workspace token unavailable", self.observedDriver?.failureCode(for: observation)
                        ?? "workspace_token_unavailable")
                    return
                }
                let data = try await transport.read(path: "/workspaces", token: token)
                guard auth.state().phase == .ready, auth.state().revision == revision else { return Self.reject(call) }
                guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]], rows.count <= 100
                else { throw W13ConnectionError.response }
                for row in rows {
                    guard Set(row.keys) == ["appointment_id", "workspace_id", "label"],
                          let appointment = row["appointment_id"] as? String, UUID(uuidString: appointment) != nil,
                          let label = row["label"] as? String, !label.isEmpty, label.count <= 200,
                          row["workspace_id"] is NSNull || (row["workspace_id"] as? String).flatMap(UUID.init(uuidString:)) != nil
                    else { throw W13ConnectionError.response }
                }
                call.resolve(["revision": revision, "encounters": rows])
            } catch W13ConnectionError.jwtRejected {
                call.reject("Workspace authorization unavailable", "workspace_jwt_rejected")
            } catch W13ConnectionError.accessDenied {
                call.reject("Workspace access unavailable", "workspace_access_denied")
            } catch {
                call.reject("Workspace connection unavailable", "workspace_connection_unavailable")
            }
        }
    }

    private var providerRequestsAvailable: Bool {
        guard self.bridge?.config.loggingEnabled == false, !CAPLog.enableLogging,
              let settings = Bundle.main.object(forInfoDictionaryKey: "ScribeProviderReceiver") as? [String: Any]
        else { return false }
        return (try? ProviderNativeTransport(settings: settings)) != nil
    }

    @objc nonisolated public func getProviderState(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.isEmpty else { return Self.rejectProvider(call) }
            self.initializeAuth()
            guard let auth = self.auth else { return Self.rejectProvider(call) }
            let state = auth.state()
            var value = Self.payload(state)
            if let name = auth.providerDisplayName(expectedRevision: state.revision) {
                value["providerDisplayName"] = name
            }
            value["providerReady"] = self.providerRequestsAvailable
            if self.nativeRecordingAvailable {
                value["nativeRecordingVersion"] = 2
                value["nativePassagePlaybackVersion"] = 1
                value["recordingSignInPreparationVersion"] = 1
            }
            call.resolve(value)
        }
    }

    @objc nonisolated public func prepareProviderSignIn(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard self.nativeRecordingAvailable, self.providerRequestsAvailable,
                  Set(call.options.keys) == ["preparationId", "revision", "workspaceId", "bindingRef"],
                  let preparation = call.getString("preparationId"), let revision = call.getString("revision"),
                  let workspace = call.getString("workspaceId"), let binding = call.getString("bindingRef"),
                  let connection = self.providerConnection else { return Self.rejectProvider(call) }
            do {
                try connection.prepareVisitSignIn(revision: revision, workspaceID: workspace,
                    bindingRef: binding, preparationID: preparation)
                call.resolve(["revision": revision])
            } catch { Self.rejectProvider(call) }
        }
    }

    @objc nonisolated public func abandonProviderSignIn(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard Set(call.options.keys) == ["preparationId"], let preparation = call.getString("preparationId")
            else { return Self.rejectProvider(call) }
            do {
                try self.providerConnection?.abandonVisitSignIn(preparationID: preparation)
                call.resolve()
            } catch { Self.rejectProvider(call) }
        }
    }

    @objc nonisolated public func providerRequest(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard self.providerRequestsAvailable,
                  Set(call.options.keys) == ["requestId", "revision", "action", "key", "body"],
                  let identifier = call.getString("requestId"), let revision = call.getString("revision"),
                  let action = call.getString("action"), let key = call.getString("key"),
                  let body = call.getString("body") else { return Self.rejectProvider(call) }
            do {
                let request = try ProviderNativeRequest(id: identifier, revision: revision,
                    action: action, key: key, body: body)
                self.initializeAuth()
                if self.providerConnection == nil {
                    guard let auth = self.auth,
                          let settings = Bundle.main.object(forInfoDictionaryKey: "ScribeProviderReceiver") as? [String: Any]
                    else { throw ProviderNativeError.unavailable }
                    self.providerConnection = NativeProviderConnection(auth: auth,
                        wire: try ProviderNativeTransport(settings: settings),
                        nativeAdmissionPreparationEnabled: self.nativeRecordingAvailable, setupVisitSignInEnabled: self.nativeRecordingAvailable)
                }
                guard let connection = self.providerConnection else { throw ProviderNativeError.unavailable }
                try await self.recoverSources(connection: connection)
                let reply: ProviderNativeReply
                if request.action == .recorderContext {
                    guard self.nativeRecordingAvailable else { throw ProviderNativeError.unavailable }
                    reply = try await connection.prepareRecordingContext(request)
                } else { reply = try await connection.send(request) }
                guard self.providerRequestsAvailable,
                      let response = String(data: reply.body, encoding: .utf8) else {
                    throw ProviderNativeError.response
                }
                call.resolve(["requestId": identifier, "revision": revision,
                    "status": reply.status, "body": response])
            } catch { Self.rejectProvider(call) }
        }
    }

    private var nativeRecordingAvailable: Bool {
        #if os(iOS)
        return providerRequestsAvailable
            && (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String])?.contains("audio") == true
        #else
        return false
        #endif
    }

    @objc nonisolated public func openProviderRecording(_ call: CAPPluginCall) {
        Task { @MainActor in
            #if os(iOS)
            do {
                guard let options = call.options as? [String: Any] else { throw ProviderNativeError.invalidRequest }
                let selection = try NativeProviderRecordingSelection(options)
                self.initializeAuth()
                guard self.nativeRecordingAvailable, let auth = self.auth,
                      let connection = self.providerConnection else { throw ProviderNativeError.unavailable }
                try await self.recoverSources(connection: connection)
                guard let recovery = self.sourceRecovery else { throw ProviderNativeError.unavailable }
                let current: @MainActor @Sendable () throws -> Void = {
                    guard self.nativeRecordingAvailable, auth.state().phase == .ready,
                          auth.state().revision == selection.revision else { throw ProviderNativeError.authorityChanged }
                }
                Self.passagePlayback.stopAll()
                let result = try await Self.recordingBridge.open(selection, current: current, make: {
                    try await NativeProviderRecordingHost.make(connection: connection, auth: auth,
                        recovery: recovery, workspaceID: selection.workspaceID, bindingRef: selection.bindingRef,
                        sessionID: selection.sessionID, revision: selection.revision, authorizationID: selection.authorizationID)
                }, inputMuted: { AVAudioApplication.shared.isInputMuted })
                call.resolve(result)
            } catch { Self.rejectProvider(call) }
            #else
            Self.rejectProvider(call)
            #endif
        }
    }

    @objc nonisolated public func recordProviderReadyTiming(_ call: CAPPluginCall) {
        Task { @MainActor in
            #if os(iOS)
            guard let value = call.options as? [String: Any], Set(value.keys) == ["revision", "durationMs"],
                  let revision = value["revision"] as? String,
                  UUID(uuidString: revision)?.uuidString.lowercased() == revision,
                  let number = value["durationMs"] as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, (0...3_600_000).contains(number.doubleValue),
                  self.nativeRecordingAvailable, let auth = self.auth,
                  auth.state().phase == .ready, auth.state().revision == revision
            else { Self.rejectProvider(call); return }
            Self.recordingBridge.recordReadyTiming(revision: revision, milliseconds: number.doubleValue)
            call.resolve()
            #else
            Self.rejectProvider(call)
            #endif
        }
    }

    @objc nonisolated public func providerRecordingCommand(_ call: CAPPluginCall) {
        Task { @MainActor in
            #if os(iOS)
            do {
                guard let options = call.options as? [String: Any] else { throw ProviderNativeError.invalidRequest }
                let request = try NativeProviderRecordingCommand(options)
                if request.kind == .start { Self.passagePlayback.stopAll() }
                let result = try await Self.recordingBridge.command(request, current: {
                    guard self.nativeRecordingAvailable, let auth = self.auth, auth.state().phase == .ready,
                          auth.state().revision == request.revision else { throw ProviderNativeError.authorityChanged }
                }, inputMuted: { AVAudioApplication.shared.isInputMuted })
                call.resolve(result)
            } catch { Self.rejectProvider(call) }
            #else
            Self.rejectProvider(call)
            #endif
        }
    }

    private func observePassageLifecycle() {
        #if os(iOS)
        guard passageObservations.isEmpty else { return }
        for name in [UIApplication.willResignActiveNotification, AVAudioSession.interruptionNotification] {
            let token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in Self.passagePlayback.stopAll() }
            }
            passageObservations.append(RecordingOpenObservation(token))
        }
        #endif
    }

    private static func passagePayload(_ state: NativePassagePlayback.State?) -> [String: Any] {
        guard let state else { return ["available": false] }
        return ["available": true, "playing": state.playing, "positionMs": state.positionMs, "durationMs": state.durationMs]
    }

    @objc nonisolated public func playProviderPassage(_ call: CAPPluginCall) {
        Task { @MainActor in
            #if os(iOS)
            do {
                guard let options = call.options as? [String: Any] else { throw ProviderNativeError.invalidRequest }
                let selection = try NativeProviderPassageSelection(options)
                self.initializeAuth(); self.observePassageLifecycle()
                guard let connection = self.providerConnection else { throw ProviderNativeError.unavailable }
                let current: @MainActor () throws -> Void = {
                    guard self.nativeRecordingAvailable, let auth = self.auth, auth.state().phase == .ready,
                        auth.state().revision == selection.revision, UIApplication.shared.applicationState == .active,
                        Self.recordingBridge.permitsPassagePlayback, self.providerSourceOwner == nil,
                        self.providerSourcePreparation == nil else { throw ProviderNativeError.authorityChanged }
                }
                try current(); Self.passageRevision = selection.revision
                let state = try await Self.passagePlayback.play(requestID: selection.requestID, current: current,
                    prepare: { try await connection.passageAudio(selection, current: current) },
                    makePlayer: { try LiveNativePassagePlayer($0) })
                call.resolve(Self.passagePayload(state))
            } catch { Self.rejectProvider(call) }
            #else
            Self.rejectProvider(call)
            #endif
        }
    }

    @objc nonisolated public func readProviderPassage(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard Set(call.options.keys) == ["requestId", "revision"], let auth = self.auth,
                    auth.state().phase == .ready, auth.state().revision == call.getString("revision"),
                    Self.passageRevision == auth.state().revision else { throw ProviderNativeError.authorityChanged }
                let id = try NativeProviderPassageSelection.uuid(call.getString("requestId"))
                call.resolve(Self.passagePayload(Self.passagePlayback.state(requestID: id)))
            } catch { Self.rejectProvider(call) }
        }
    }

    @objc nonisolated public func stopProviderPassage(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard Set(call.options.keys) == ["requestId"] else { throw ProviderNativeError.invalidRequest }
                let id = try NativeProviderPassageSelection.uuid(call.getString("requestId"))
                try Self.passagePlayback.stop(requestID: id)
                self.providerConnection?.cancel(id)
                call.resolve()
            } catch { Self.rejectProvider(call) }
        }
    }

    @objc nonisolated public func cancelProviderRequest(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.count == 1, let identifier = call.getString("requestId"),
                  let id = UUID(uuidString: identifier), id.uuidString.lowercased() == identifier
            else { return Self.rejectProvider(call) }
            // Construct the same connection even if cancellation arrives before
            // the request's MainActor task. It must retain that cancellation.
            do {
                self.initializeAuth()
                if self.providerConnection == nil {
                    guard let auth = self.auth,
                          let settings = Bundle.main.object(forInfoDictionaryKey: "ScribeProviderReceiver") as? [String: Any]
                    else { throw ProviderNativeError.unavailable }
                    self.providerConnection = NativeProviderConnection(auth: auth,
                        wire: try ProviderNativeTransport(settings: settings),
                        nativeAdmissionPreparationEnabled: self.nativeRecordingAvailable, setupVisitSignInEnabled: self.nativeRecordingAvailable)
                }
                self.providerConnection?.cancel(id)
                call.resolve()
            } catch { Self.rejectProvider(call) }
        }
    }

    @objc nonisolated public func getProviderConfiguration(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard call.options.isEmpty, Bundle.main.bundleIdentifier == "com.cosmaneura.scribe.beta" else {
                return Self.rejectProvider(call)
            }
            guard let configuration = Self.providerApplicationConfiguration() else { return Self.rejectProvider(call) }
            call.resolve(configuration)
        }
    }

    @objc nonisolated public func openProviderCore(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard self.providerRequestsAvailable, self.auth?.state().phase == .ready,
                  Set(call.options.keys) == ["appointmentRef"] else { return Self.rejectProvider(call) }
            let path: String
            if let appointment = call.getString("appointmentRef"),
               appointment.range(of: "^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression) != nil {
                path = "/notes/" + appointment
            } else if call.options["appointmentRef"] is NSNull { path = "/notes" }
            else { return Self.rejectProvider(call) }
            #if os(iOS)
            guard let configuration = Self.providerApplicationConfiguration(),
                  let origin = configuration["coreOrigin"] as? String,
                  let url = URL(string: origin + path),
                  await UIApplication.shared.open(url) else { return Self.rejectProvider(call) }
            call.resolve()
            #else
            Self.rejectProvider(call)
            #endif
        }
    }

    @MainActor private static func providerApplicationConfiguration() -> [String: Any]? {
        let settings = Bundle.main.object(forInfoDictionaryKey: "ScribeProviderApplication") as? [String: Any] ?? [:]
        let enabled = settings["enabled"] as? Bool == true
        let origins = settings["uploadOrigins"] as? [String] ?? []
        var coreOrigin = "https://staging-app.cosmaneura.com"
        var applicationProfile: String?
        if let auth = Bundle.main.object(forInfoDictionaryKey: "CosmasNativeAuth") as? [String: Any],
           auth["frontendOrigin"] as? String == "https://clerk.cosmaneura.com", settings["profile"] == nil { return nil }
        if settings["profile"] != nil {
#if SCRIBE_PRODUCTION_ORGANIZATION && !SCRIBE_VIRTUAL_LAB_NETWORK
            guard Set(settings.keys) == ["profile", "enabled", "coreOrigin", "uploadOrigins"],
                  settings["profile"] as? String == "core-production-organization-v1",
                  settings["coreOrigin"] as? String == "https://app.cosmaneura.com",
                  let auth = Bundle.main.object(forInfoDictionaryKey: "CosmasNativeAuth") as? [String: Any],
                  auth["frontendOrigin"] as? String == "https://clerk.cosmaneura.com",
                  auth["identityProfile"] as? String == NativeIdentityProfile.clerkOrganization.rawValue,
                  let receiver = Bundle.main.object(forInfoDictionaryKey: "ScribeProviderReceiver") as? [String: Any],
                  receiver["profile"] as? String == "core-production-organization-https-v1"
            else { return nil }
            coreOrigin = "https://app.cosmaneura.com"
            applicationProfile = "core-production-organization-v1"
#else
            return nil
#endif
        } else if !Set(settings.keys).isSubset(of: ["enabled", "uploadOrigins"]) { return nil }
        guard origins.count <= 1, (!enabled || origins.count == 1),
              origins.allSatisfy({ $0.range(of: "^https://[a-z0-9]{3,24}\\.blob\\.core\\.windows\\.net$",
                                              options: .regularExpression) != nil }) else { return nil }
        var configuration: [String: Any] = ["enabled": enabled, "coreOrigin": coreOrigin, "uploadOrigins": origins]
        if let applicationProfile { configuration["profile"] = applicationProfile }
        return configuration
    }

    @objc nonisolated public func prepareProviderSource(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard self.providerRequestsAvailable,
                  Set<AnyHashable>(call.options.keys.filter { $0 != AnyHashable("firstSequenceNumber") }) == ["revision", "workspaceId", "bindingRef", "sessionId",
                    "leaseId", "leaseReceiptId", "leaseGeneration", "captureAuthorizedUntil"],
                  let revision = call.getString("revision"),
                  let workspace = call.getString("workspaceId").flatMap(UUID.init(uuidString:)),
                  let binding = call.getString("bindingRef"),
                  let session = call.getString("sessionId").flatMap(UUID.init(uuidString:)),
                  let lease = call.getString("leaseId").flatMap(UUID.init(uuidString:)),
                  let receipt = call.getString("leaseReceiptId").flatMap(UUID.init(uuidString:)),
                  let number = call.options["leaseGeneration"] as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.rounded(.down) == number.doubleValue,
                  number.doubleValue > 0, number.doubleValue < 2_147_483_648,
                  let generation = call.getInt("leaseGeneration"),
                  let deadline = call.getString("captureAuthorizedUntil") else {
                return Self.rejectProvider(call)
            }
            do {
                self.initializeAuth()
                guard let auth = self.auth, auth.state().phase == .ready,
                      auth.state().revision == revision else { throw ProviderNativeError.unavailable }
                Self.passagePlayback.stopAll()
                let preparation = try NativeSourcePreparation(workspaceID: workspace, bindingRef: binding,
                    sessionID: session, leaseID: lease, leaseReceiptID: receipt,
                    leaseGeneration: generation, captureAuthorizedUntil: deadline, source: .ios,
                    firstSequenceNumber: nativeSourceFirstSequence(call.options["firstSequenceNumber"]))
                if let prior = self.providerSourcePreparation, prior != preparation {
                    throw ProviderNativeError.unavailable
                }
                if self.providerConnection == nil {
                    guard let settings = Bundle.main.object(forInfoDictionaryKey: "ScribeProviderReceiver") as? [String: Any]
                    else { throw ProviderNativeError.unavailable }
                    self.providerConnection = NativeProviderConnection(auth: auth,
                        wire: try ProviderNativeTransport(settings: settings),
                        nativeAdmissionPreparationEnabled: self.nativeRecordingAvailable, setupVisitSignInEnabled: self.nativeRecordingAvailable)
                }
                guard let connection = self.providerConnection else { throw ProviderNativeError.unavailable }
                try await self.recoverSources(connection: connection)
                guard auth.state().phase == .ready, auth.state().revision == revision,
                      let sourceRecovery = self.sourceRecovery else { throw ProviderNativeError.unavailable }
                try sourceRecovery.requireReady()
                if let prior = self.providerSourcePreparation, prior != preparation {
                    throw ProviderNativeError.unavailable
                }
                if self.providerSourceOwner == nil {
                    guard let connection = self.providerConnection,
                          let identity = auth.state().identity else { throw ProviderNativeError.unavailable }
                    self.providerSourceOwner = try NativeSourceStartOwner(connection: connection,
                        revision: revision, preparation: preparation, identity: identity,
                        journal: sourceRecovery.journal, stopRevision: { [weak connection] in
                            guard let connection else { throw ProviderNativeError.unavailable }
                            return try connection.stopRevision(for: identity)
                        })
                    self.providerSourcePreparation = preparation
                    self.providerSourceRevision = revision; self.providerSourceID = UUID()
                }
                guard let owner = self.providerSourceOwner, let ownerID = self.providerSourceID else {
                    throw ProviderNativeError.unavailable
                }
                try NativeCaptureStartGate.install(owner: ownerID) {
                    try await owner.consumeForMicrophone()
                }
                _ = try await owner.prepare()
                guard self.providerSourceID == ownerID, auth.state().phase == .ready,
                      auth.state().revision == revision else { throw ProviderNativeError.unavailable }
                call.resolve(["revision": revision, "sessionId": session.uuidString.lowercased()])
            } catch { Self.rejectProvider(call) }
        }
    }

    @objc nonisolated public func closeProviderSource(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard Set(call.options.keys) == ["sessionId"], let session = call.getString("sessionId"),
                  let identifier = UUID(uuidString: session),
                  self.providerSourcePreparation == nil
                    || self.providerSourcePreparation?.sessionID == identifier else {
                return Self.rejectProvider(call)
            }
            do {
                if let owner = self.providerSourceOwner, let ownerID = self.providerSourceID {
                    try NativeCaptureStartGate.confirmStopped(owner: ownerID)
                    try await owner.confirmStopped()
                    guard self.providerSourceID == ownerID else { throw ProviderNativeError.unavailable }
                }
                self.clearProviderSource(); call.resolve()
            } catch { Self.rejectProvider(call) }
        }
    }

    private func recoverSources(connection: NativeProviderConnection) async throws {
        if sourceRecovery == nil {
            let journal = try NativeSourceProofJournal(platform: .ios,
                backing: KeychainNativeSourceJournal(platform: .ios,
                    bundleIdentifier: Bundle.main.bundleIdentifier ?? ""))
            sourceRecovery = NativeSourceRecovery(journal: journal)
        }
        guard let sourceRecovery else { throw ProviderNativeError.unavailable }
        try await sourceRecovery.recover(connection: connection)
    }

    private func invalidateProviderSource() {
        // Revoke every possible start while retaining original stop-only custody.
        // Process recovery must pass the native idle barrier before journal retirement.
        if let owner = providerSourceID { NativeCaptureStartGate.retire(owner: owner) }
        providerSourceOwner?.retireForAuthenticationChange()
    }

    private func clearProviderSource() {
        if let owner = providerSourceID { NativeCaptureStartGate.clear(owner: owner) }
        providerSourceOwner?.close(); providerSourceOwner = nil; providerSourcePreparation = nil
        providerSourceRevision = nil; providerSourceID = nil
    }

    private static func rejectProvider(_ call: CAPPluginCall) {
        call.reject("Provider request unavailable", "provider_native_unavailable")
    }
    @MainActor private static func payload(_ state: NativeAuthState) -> [String: Any] {
        NativeAuthPayload.state(state)
    }

    private static func reject(_ call: CAPPluginCall) {
        call.reject("Secure session operation unavailable", NativeAuthError.unavailable.rawValue)
    }
}

private final class RecordingOpenObservation: @unchecked Sendable {
    let token: NSObjectProtocol
    init(_ token: NSObjectProtocol) { self.token = token }
    deinit { NotificationCenter.default.removeObserver(token) }
}
