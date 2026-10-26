import CosmasNativeAuth
import CryptoKit
import Foundation
import Security
#if SCRIBE_VIRTUAL_LAB_NETWORK
import Network
#endif

/// Six fixed POST routes. Private pinned TLS and the proposed staging system-TLS
/// profile are explicit alternatives. Neither changes system trust or Keychain.
final class ProviderNativeTransport: NSObject, ProviderNativeWire, URLSessionDelegate,
  URLSessionTaskDelegate, @unchecked Sendable
{
  private let endpoint: URL
  private let host: String
  private let port: Int
  private let anchor: SecCertificate?
  private let leafSHA256: String?
  private let workspaceOrigin: NativeWorkspaceOrigin
  private let sessionFactory: (URLSessionConfiguration, URLSessionDelegate) -> URLSession
  private let sessionLock = NSLock()
  private var sessions: [TimeoutProfile: URLSession] = [:]
#if SCRIBE_VIRTUAL_LAB_NETWORK
  private let labNetwork: ProviderLabNetworkConfiguration
#endif
  static let stagingHost =
    "cosmaneura-staging-scribe-native.politesmoke-7989878f.northcentralus.azurecontainerapps.io"

  init(
    settings: [String: Any], workspaceOrigin: NativeWorkspaceOrigin = .appleWebView,
    sessionFactory: @escaping (URLSessionConfiguration, URLSessionDelegate) -> URLSession = {
      URLSession(configuration: $0, delegate: $1, delegateQueue: nil)
    }
  ) throws {
#if SCRIBE_VIRTUAL_LAB_NETWORK
    // This build flavor is confined to the existing staging provider origin.
    // No renderer setting, URL override, environment proxy or trust change.
    guard settings["profile"] as? String == "core-staging-https-v1" else {
      throw ProviderNativeError.unavailable
    }
    self.labNetwork = try ProviderLabNetworkConfiguration.load()
#endif
    guard
      workspaceOrigin == .appleWebView
        || Bundle.main.bundleIdentifier == NativeClerkConfiguration.desktopBundleIdentifier
    else {
      throw ProviderNativeError.unavailable
    }
    self.workspaceOrigin = workspaceOrigin
    self.sessionFactory = sessionFactory
    if settings["profile"] != nil {
      guard Set(settings.keys) == ["profile", "endpoint"],
        settings["profile"] as? String == "core-staging-https-v1",
        let value = settings["endpoint"] as? String,
        value == "https://" + Self.stagingHost, let endpoint = URL(string: value)
      else {
        throw ProviderNativeError.unavailable
      }
      self.endpoint = endpoint
      self.host = Self.stagingHost
      self.port = 443
      self.anchor = nil
      self.leafSHA256 = nil
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
      leaf.count == 64, leaf.allSatisfy({ $0.isHexDigit && !$0.isUppercase })
    else {
      throw ProviderNativeError.unavailable
    }
    self.endpoint = endpoint
    self.host = host
    self.port = port
    self.anchor = anchor
    self.leafSHA256 = leaf
    super.init()
  }

  deinit {
    for session in sessions.values { session.invalidateAndCancel() }
  }

  private enum TimeoutProfile {
    case standard, admission, note
  }

  // Reuse Apple's connection pool without sharing cookies, credentials or
  // response caches. Separate timeout profiles preserve each route's budget.
  private func session(for action: ProviderNativeAction) throws -> URLSession {
    let profile: TimeoutProfile =
      action == .admission ? .admission : (action == .note || action == .noteOpening) ? .note : .standard
    sessionLock.lock()
    defer { sessionLock.unlock() }
    if let existing = sessions[profile] { return existing }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    // Admission includes two Core phases plus receiver authorization. This
    // waiting budget never authorizes recording or renews source authority.
    configuration.timeoutIntervalForRequest =
      profile == .admission ? 200 : profile == .note ? 110 : 20
    configuration.timeoutIntervalForResource =
      profile == .admission ? 210 : profile == .note ? 120 : 30
#if SCRIBE_VIRTUAL_LAB_NETWORK
    try labNetwork.apply(to: configuration)
#endif
    let created = sessionFactory(configuration, SessionDelegate(owner: self))
    sessions[profile] = created
    return created
  }

  // URLSession retains its delegate until invalidation. A weak forwarding
  // delegate lets this transport release and invalidate the retained pool.
  private final class SessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    weak var owner: ProviderNativeTransport?
    init(owner: ProviderNativeTransport) { self.owner = owner }

    func urlSession(
      _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
      completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
      guard let owner else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      owner.urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func urlSession(
      _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
      completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
      urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func urlSession(
      _ session: URLSession, task: URLSessionTask,
      willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      completionHandler(nil)
    }
  }

  private static func privateIPv4(_ value: String) -> Bool {
    let octets = value.split(separator: ".", omittingEmptySubsequences: false).compactMap {
      UInt8($0)
    }
    guard octets.count == 4, octets.map(String.init).joined(separator: ".") == value else {
      return false
    }
    return octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1]))
      || (octets[0] == 192 && octets[1] == 168)
  }

  func send(_ operation: ProviderNativeRequest, token: String) async throws -> ProviderNativeReply {
    guard operation.action != .recorderContext else { throw ProviderNativeError.invalidRequest }
    try Task.checkCancellation()
    guard !token.isEmpty, token.utf8.count <= 8192,
      token.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 33 && $0.value < 127 })
    else {
      throw ProviderNativeError.unavailable
    }
#if SCRIBE_VIRTUAL_LAB_NETWORK
    // Expiry refuses new requests; it does not cancel an already issued task or
    // grant/renew any native recording authority.
    try labNetwork.requireCurrent()
#endif
    let session = try session(for: operation.action)
    var request = URLRequest(
      url: endpoint.appendingPathComponent("provider/v1/" + operation.action.rawValue))
    request.httpMethod = "POST"
    request.httpBody = operation.body
    request.setValue(workspaceOrigin.rawValue, forHTTPHeaderField: "Origin")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    request.setValue(operation.revision, forHTTPHeaderField: "X-Scribe-Native-Revision")
    request.setValue(operation.key, forHTTPHeaderField: "Idempotency-Key")
    do {
      let (bytes, response) = try await session.bytes(for: request)
      // Stop only this response on every exit, including invalid headers
      // or size limits. Other requests using the pool must keep running.
      defer { bytes.task.cancel() }
      guard let http = response as? HTTPURLResponse, http.url == request.url,
        operation.action.acceptsResponseStatus(http.statusCode),
        http.mimeType == "application/json",
        http.value(forHTTPHeaderField: "Cache-Control")?.split(separator: ",").contains(where: {
          $0.trimmingCharacters(in: .whitespaces).lowercased() == "no-store"
        }) == true
      else { throw ProviderNativeError.response }
      var data = Data()
      let responseLimit = operation.responseLimit
      for try await byte in bytes {
        try Task.checkCancellation()
        guard data.count < responseLimit else {
          throw ProviderNativeError.response
        }
        data.append(byte)
      }
      try Task.checkCancellation()
      return ProviderNativeReply(status: http.statusCode, body: data,
                                 serverTiming: ProviderServerTiming.from(http),
                                 coreTiming: ProviderCoreTiming.from(http))
    } catch {
      // No HTTP body, URL, token, framework exception or TLS detail escapes.
      throw ProviderNativeError.unavailable
    }
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      challenge.protectionSpace.host == host, challenge.protectionSpace.port == port,
      let trust = challenge.protectionSpace.serverTrust
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    if let anchor, let leafSHA256 {
      guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
        let leaf = chain.first,
        SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map({ String(format: "%02x", $0) })
          .joined() == leafSHA256,
        SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
        SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
      else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
    } else if anchor != nil || leafSHA256 != nil || host != Self.stagingHost || port != 443 {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    // Public profile uses the platform's normal trust chain and exact DNS
    // name. A copied private CA/pin can never enter this profile's settings.
    guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
      SecTrustEvaluateWithError(trust, nil)
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    urlSession(session, didReceive: challenge, completionHandler: completionHandler)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

#if SCRIBE_VIRTUAL_LAB_NETWORK
/// Present only in an explicitly instrumented lab build. The resource is part
/// of that build's signed bundle inventory, never a renderer/process setting.
struct ProviderLabNetworkConfiguration {
  let runId: String
  let issuedAt: Int
  let expiresAt: Int
  let proxyPort: UInt16
  private let deadline: ContinuousClock.Instant

  init(data: Data, now: Date = Date(), continuousNow: ContinuousClock.Instant = ContinuousClock().now) throws {
    guard data.count <= 1024,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["version", "runId", "issuedAtUnixSeconds", "expiresAtUnixSeconds", "proxyPort"],
      let version = Self.integer(object["version"]), version == 1,
      let runId = object["runId"] as? String, let parsedRun = UUID(uuidString: runId),
      runId == parsedRun.uuidString.lowercased(),
      let issued = Self.integer(object["issuedAtUnixSeconds"]),
      let expires = Self.integer(object["expiresAtUnixSeconds"]),
      let port = Self.integer(object["proxyPort"]), (1024...65535).contains(port),
      issued > 0, issued <= 4_102_444_800, expires > issued, expires - issued <= 3600
    else { throw ProviderNativeError.unavailable }
    let seconds = now.timeIntervalSince1970
    guard seconds.isFinite, seconds >= Double(issued), seconds < Double(expires) else {
      throw ProviderNativeError.unavailable
    }
    self.runId = runId; self.issuedAt = issued; self.expiresAt = expires; self.proxyPort = UInt16(port)
    self.deadline = continuousNow.advanced(by: .seconds(Double(expires) - seconds))
  }

  private static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
      number.doubleValue >= 0, number.doubleValue <= 4_102_448_400 else { return nil }
    return number.intValue
  }

  static func load(bundle: Bundle = .main) throws -> Self {
    guard let url = bundle.url(forResource: "ScribeVirtualLabNetwork", withExtension: "json"),
      url.isFileURL, let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
      size <= 1024, let data = try? Data(contentsOf: url) else { throw ProviderNativeError.unavailable }
    return try Self(data: data)
  }

  func requireCurrent(now: Date = Date(), continuousNow: ContinuousClock.Instant = ContinuousClock().now) throws {
    let seconds = now.timeIntervalSince1970
    guard seconds.isFinite, seconds >= Double(issuedAt), seconds < Double(expiresAt),
      continuousNow < deadline else {
      throw ProviderNativeError.unavailable
    }
  }

  func apply(to configuration: URLSessionConfiguration) throws {
    try requireCurrent()
    if #available(macOS 14.0, iOS 17.0, *) {
      guard let port = NWEndpoint.Port(rawValue: proxyPort) else { throw ProviderNativeError.unavailable }
      var proxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: port))
      proxy.allowFailover = false
      // Apply to every connection in this session. The unchanged transport
      // accepts only its fixed staging origin; no suffix matcher widens it.
      configuration.proxyConfigurations = [proxy]
    } else { throw ProviderNativeError.unavailable }
  }
}
#endif
