import Foundation
import Security
import CryptoKit

enum W13ConnectionError: Error {
    case configuration, connection, response, jwtRejected, accessDenied
}

/// One fixed private endpoint and one bundled certificate. This trust anchor is
/// local to this URLSession; no Keychain or system trust settings are modified.
final class W13PrivateTransport: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let endpoint: URL
    private let host: String
    private let anchor: SecCertificate
    private let leafSHA256: String
    private let diagnostic: (@Sendable (String) -> Void)?

    init(settings: [String: Any], diagnostic: (@Sendable (String) -> Void)? = nil) throws {
        guard Set(settings.keys) == ["endpoint", "caDER", "leafSHA256"],
              let value = settings["endpoint"] as? String,
              let components = URLComponents(string: value), components.scheme == "https",
              let host = components.host, Self.privateIPv4(host), components.port == 8446,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, components.path.isEmpty,
              let endpoint = components.url,
              let encoded = settings["caDER"] as? String, encoded.count < 8192,
              let der = Data(base64Encoded: encoded),
              let anchor = SecCertificateCreateWithData(nil, der as CFData),
              let leaf = settings["leafSHA256"] as? String,
              leaf.count == 64, leaf.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            throw W13ConnectionError.configuration
        }
        self.endpoint = endpoint; self.host = host; self.anchor = anchor; self.leafSHA256 = leaf
        self.diagnostic = diagnostic
        super.init()
    }

    private static func privateIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { UInt8($0) }
        guard octets.count == 4, octets.map(String.init).joined(separator: ".") == value else { return false }
        return octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) ||
            (octets[0] == 192 && octets[1] == 168)
    }

    func read(path: String, token: String? = nil) async throws -> Data {
        guard path == "/connection" && token == nil || path == "/workspaces" && token != nil else {
            throw W13ConnectionError.configuration
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: endpoint.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = "GET"
        request.setValue("capacitor://localhost", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do { (bytes, response) = try await session.bytes(for: request) }
        catch {
            diagnostic?("request_error_" + String((error as NSError).code))
            throw W13ConnectionError.connection
        }
        guard let http = response as? HTTPURLResponse, http.url == request.url else { throw W13ConnectionError.response }
        if http.statusCode == 401 { throw W13ConnectionError.jwtRejected }
        if http.statusCode == 403 { throw W13ConnectionError.accessDenied }
        guard http.statusCode == 200, http.mimeType == "application/json" else { throw W13ConnectionError.response }
        var data = Data()
        do {
            for try await byte in bytes {
                try Task.checkCancellation()
                guard data.count < 65536 else { throw W13ConnectionError.response }
                data.append(byte)
            }
        } catch { throw W13ConnectionError.response }
        return data
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        diagnostic?("trust_challenge_received")
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host, challenge.protectionSpace.port == 8446,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map({ String(format: "%02x", $0) }).joined() == leafSHA256 else {
            diagnostic?("certificate_identity_rejected")
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        guard
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else {
            diagnostic?("certificate_validation_rejected")
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        diagnostic?("certificate_validation_passed")
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
