import Foundation
import Security
import CryptoKit
import CosmasNativeAuth

/// Six fixed POST routes. Private pinned TLS and the proposed staging system-TLS
/// profile are explicit alternatives. Neither changes system trust or Keychain.
final class ProviderNativeTransport: NSObject, ProviderNativeWire, URLSessionDelegate,
    URLSessionTaskDelegate, @unchecked Sendable {
    private let endpoint: URL
    private let host: String
    private let port: Int
    private let anchor: SecCertificate?
    private let leafSHA256: String?
    private let workspaceOrigin: NativeWorkspaceOrigin
    static let stagingHost = "cosmaneura-staging-scribe-native.politesmoke-7989878f.northcentralus.azurecontainerapps.io"

    init(settings: [String: Any], workspaceOrigin: NativeWorkspaceOrigin = .appleWebView) throws {
        guard workspaceOrigin == .appleWebView
            || Bundle.main.bundleIdentifier == "com.cosmaneura.scribe.beta.desktop.auth" else {
            throw ProviderNativeError.unavailable
        }
        self.workspaceOrigin = workspaceOrigin
        if settings["profile"] != nil {
            guard Set(settings.keys) == ["profile", "endpoint"],
                  settings["profile"] as? String == "core-staging-https-v1",
                  let value = settings["endpoint"] as? String,
                  value == "https://" + Self.stagingHost, let endpoint = URL(string: value) else {
                throw ProviderNativeError.unavailable
            }
            self.endpoint = endpoint; self.host = Self.stagingHost; self.port = 443
            self.anchor = nil; self.leafSHA256 = nil
            super.init()
            return
        }
        guard Set(settings.keys) == ["endpoint", "caDER", "leafSHA256"],
              let value = settings["endpoint"] as? String,
              let components = URLComponents(string: value), components.scheme == "https",
              let host = components.host, Self.privateIPv4(host), let port = components.port,
              (1024...65535).contains(port), components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, components.path.isEmpty,
              let endpoint = components.url, endpoint.absoluteString == value,
              let encoded = settings["caDER"] as? String, encoded.count < 8192,
              let der = Data(base64Encoded: encoded),
              let anchor = SecCertificateCreateWithData(nil, der as CFData),
              let leaf = settings["leafSHA256"] as? String,
              leaf.count == 64, leaf.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            throw ProviderNativeError.unavailable
        }
        self.endpoint = endpoint; self.host = host; self.port = port
        self.anchor = anchor; self.leafSHA256 = leaf
        super.init()
    }

    private static func privateIPv4(_ value: String) -> Bool {
        let octets = value.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
        guard octets.count == 4, octets.map(String.init).joined(separator: ".") == value else { return false }
        return octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) ||
            (octets[0] == 192 && octets[1] == 168)
    }

    func send(_ operation: ProviderNativeRequest, token: String) async throws -> ProviderNativeReply {
        try Task.checkCancellation()
        guard !token.isEmpty, token.utf8.count <= 8192,
              token.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 33 && $0.value < 127 }) else {
            throw ProviderNativeError.unavailable
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        // Admission includes two Core phases plus receiver authorization. This
        // waiting budget never authorizes recording or renews source authority.
        configuration.timeoutIntervalForRequest = operation.action == .admission ? 200 : operation.action == .note ? 110 : 20
        configuration.timeoutIntervalForResource = operation.action == .admission ? 210 : operation.action == .note ? 120 : 30
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: endpoint.appendingPathComponent("provider/v1/" + operation.action.rawValue))
        request.httpMethod = "POST"; request.httpBody = operation.body
        request.setValue(workspaceOrigin.rawValue, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue(operation.revision, forHTTPHeaderField: "X-Scribe-Native-Revision")
        request.setValue(operation.key, forHTTPHeaderField: "Idempotency-Key")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.url == request.url,
                  [200, 401, 403, 409, 422, 503].contains(http.statusCode),
                  http.mimeType == "application/json",
                  http.value(forHTTPHeaderField: "Cache-Control")?.split(separator: ",").contains(where: {
                      $0.trimmingCharacters(in: .whitespaces).lowercased() == "no-store"
                  }) == true else { throw ProviderNativeError.response }
            var data = Data()
            for try await byte in bytes {
                try Task.checkCancellation()
                guard data.count < operation.action.responseLimit else { throw ProviderNativeError.response }
                data.append(byte)
            }
            try Task.checkCancellation()
            return ProviderNativeReply(status: http.statusCode, body: data)
        } catch {
            // No HTTP body, URL, token, framework exception or TLS detail escapes.
            throw ProviderNativeError.unavailable
        }
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host, challenge.protectionSpace.port == port,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        if let anchor, let leafSHA256 {
            guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
                  SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map({ String(format: "%02x", $0) }).joined() == leafSHA256,
                  SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
                  SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else {
                completionHandler(.cancelAuthenticationChallenge, nil); return
            }
        } else if anchor != nil || leafSHA256 != nil || host != Self.stagingHost || port != 443 {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        // Public profile uses the platform's normal trust chain and exact DNS
        // name. A copied private CA/pin can never enter this profile's settings.
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
