import Foundation

// Compile with the approved copied configuration and its retained native types.
// Configuration validation only: no SDK, Keychain, app launch or network calls.
private enum IdentityCheckFailure: Error { case failed }

@main struct CheckStandaloneIdentity {
    static func main() throws {
        guard CommandLine.arguments.count == 2,
              let input = try JSONSerialization.jsonObject(
                with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as? [String: Any],
              let key = input["publishableKey"] as? String,
              let frontend = input["frontendOrigin"] as? String,
              let organization = input["organizationId"] as? String else { throw IdentityCheckFailure.failed }
        func configuration(_ bundle: String, _ origin: NativeWorkspaceOrigin = .appleWebView,
                           _ suppliedKey: String? = nil) throws -> NativeClerkConfiguration {
            try NativeClerkConfiguration(publishableKey: suppliedKey ?? key,
                frontendOrigin: frontend, organizationID: organization,
                bundleIdentifier: bundle, workspaceOrigin: origin)
        }
        let accepted = try configuration("com.cosmaneura.scribe.beta")
        guard accepted.callbackURL == "com.cosmaneura.scribe.beta://callback",
              accepted.workspaceOrigin == .appleWebView,
              accepted.frontendOrigin == frontend,
              accepted.organizationID == organization else { throw IdentityCheckFailure.failed }
        var rejected = 0
        for bundle in ["com.cosmaneura.scribe", "com.cosmaneura.scribe.beta.extra",
                       "com.cosmaneura.scribe.beta2", "com.cosmaneura.scribe.production",
                       "Com.cosmaneura.scribe.beta", "com.cosmaneura.scribe.beta "] {
            do { _ = try configuration(bundle); throw IdentityCheckFailure.failed }
            catch NativeAuthError.unavailable { rejected += 1 }
        }
        do {
            _ = try configuration("com.cosmaneura.scribe.beta", .desktopApp)
            throw IdentityCheckFailure.failed
        } catch NativeAuthError.unavailable { rejected += 1 }
        do {
            _ = try configuration("com.cosmaneura.scribe.beta", .appleWebView,
                                  key.replacingOccurrences(of: "pk_test_", with: "pk_live_"))
            throw IdentityCheckFailure.failed
        } catch NativeAuthError.unavailable { rejected += 1 }
        _ = try configuration("com.cosmasos.synthetic.w13")
        _ = try configuration("com.cosmasos.synthetic.desktop.auth.w8u", .desktopApp)
        guard rejected == 8 else { throw IdentityCheckFailure.failed }
        print("Identity configuration: standalone callback accepted; 8 boundary rejections; W13 and existing desktop profiles preserved. No credentials or runtime used.")
    }
}
