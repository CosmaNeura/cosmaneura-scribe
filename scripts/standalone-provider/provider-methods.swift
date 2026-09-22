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
            var value = Self.payload(auth.state())
            value["providerReady"] = self.providerRequestsAvailable
            call.resolve(value)
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
                        wire: try ProviderNativeTransport(settings: settings))
                }
                guard let connection = self.providerConnection else { throw ProviderNativeError.unavailable }
                let reply = try await connection.send(request)
                guard self.providerRequestsAvailable,
                      let response = String(data: reply.body, encoding: .utf8) else {
                    throw ProviderNativeError.response
                }
                call.resolve(["requestId": identifier, "revision": revision,
                    "status": reply.status, "body": response])
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
                        wire: try ProviderNativeTransport(settings: settings))
                }
                self.providerConnection?.cancel(id)
                call.resolve()
            } catch { Self.rejectProvider(call) }
        }
    }

    private static func rejectProvider(_ call: CAPPluginCall) {
        call.reject("Provider request unavailable", "provider_native_unavailable")
    }
