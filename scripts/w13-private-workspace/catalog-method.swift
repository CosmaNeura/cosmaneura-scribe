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
                do { token = try await auth.token(expectedRevision: revision) }
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
