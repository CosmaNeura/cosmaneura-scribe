import CosmasNativeAuth
import Foundation

// Offline URLProtocol fixture: intercepts every request before DNS/TLS. No
// account, microphone, clinical content, network or persistent store is used.
private final class Fixture: URLProtocol, @unchecked Sendable {
  static let lock = NSLock()
  static var seen: [URLRequest] = []
  static var held: [String: Fixture] = [:]
  static var stopped: Set<String> = []
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let key = request.value(forHTTPHeaderField: "Idempotency-Key")!
    Self.lock.lock()
    Self.seen.append(request)
    if key.contains("hold") { Self.held[key] = self }
    Self.lock.unlock()
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": "application/json",
        "Cache-Control": key.contains("invalid") ? "public" : "no-store",
      ])!
    client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    if key.contains("oversize") {
      client!.urlProtocol(self, didLoad: Data(repeating: 32, count: 8193))
    } else if key.contains("hold") || key.contains("invalid") {
      client!.urlProtocol(self, didLoad: Data("{".utf8))
    } else {
      client!.urlProtocol(self, didLoad: Data("{}".utf8))
      client!.urlProtocolDidFinishLoading(self)
    }
  }
  override func stopLoading() {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    Self.stopped.insert(request.value(forHTTPHeaderField: "Idempotency-Key")!)
    Self.held.removeValue(forKey: request.value(forHTTPHeaderField: "Idempotency-Key")!)
  }
  static func requests() -> [URLRequest] {
    lock.lock()
    defer { lock.unlock() }
    return seen
  }
  static func didStop(_ key: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopped.contains(key)
  }
  static func finish(_ key: String) {
    lock.lock()
    let fixture = held.removeValue(forKey: key)
    lock.unlock()
    fixture!.client!.urlProtocol(fixture!, didLoad: Data("}".utf8))
    fixture!.client!.urlProtocolDidFinishLoading(fixture!)
  }
}

private final class Factory: @unchecked Sendable {
  let lock = NSLock()
  var sessions: [URLSession] = []
  func make(_ configuration: URLSessionConfiguration, _ delegate: URLSessionDelegate) -> URLSession
  {
    configuration.protocolClasses = [Fixture.self]
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    lock.lock()
    sessions.append(session)
    lock.unlock()
    return session
  }
}

private enum CheckFailure: Error { case failed(String) }
private func require(_ condition: Bool, _ label: String) throws {
  if !condition { throw CheckFailure.failed(label) }
}
private func request(_ action: String = "recorder", key: String = "offline-normal-key") throws
  -> ProviderNativeRequest
{
  try ProviderNativeRequest(
    id: UUID().uuidString.lowercased(), revision: UUID().uuidString.lowercased(),
    action: action, key: key, body: "{}")
}
private func wait(_ condition: () -> Bool) async throws {
  for _ in 0..<2000 {
    if condition() { return }
    try await Task.sleep(for: .milliseconds(1))
  }
  throw CheckFailure.failed("bounded wait")
}
private func rejected(_ operation: Task<ProviderNativeReply, Error>) async throws {
  do {
    _ = try await operation.value
    throw CheckFailure.failed("accepted invalid request")
  } catch is ProviderNativeError {}
}

@main struct CheckNativeTransport {
  static func main() async throws {
    let factory = Factory()
    var transport: ProviderNativeTransport? = try ProviderNativeTransport(
      settings: [
        "profile": "core-staging-https-v1",
        "endpoint": "https://" + ProviderNativeTransport.stagingHost,
      ], sessionFactory: factory.make)
    let retainedTransport = WeakTransport(transport!)
    var checks = 0

    for action in ["catalog", "mount", "recorder", "capture-operations", "catalog"] {
      let reply = try await transport!.send(request(action), token: "offline-token-\(action)")
      try require(reply.status == 200 && reply.body == Data("{}".utf8), "fresh response")
    }
    let native = try ProviderNativeRequest(
      nativeStartID: UUID(), revision: UUID().uuidString.lowercased(),
      key: "offline-native-start", body: Data("{}".utf8))
    _ = try await transport!.send(native, token: "offline-native-token")
    try require(
      factory.sessions.count == 1 && Fixture.requests().count == 6,
      "one standard pool, six requests")
    try require(
      Fixture.requests().last!.value(forHTTPHeaderField: "Authorization")
        == "Bearer offline-native-token",
      "fresh per-request authorization")
    checks += 1

    for action in ["capture-admissions", "capture-notes", "capture-admissions", "capture-notes"] {
      _ = try await transport!.send(request(action), token: "offline-token")
    }
    try require(factory.sessions.count == 3, "bounded timeout pools")
    let expected: [(Double, Double)] = [(20, 30), (200, 210), (110, 120)]
    for (index, session) in factory.sessions.enumerated() {
      let config = session.configuration
      try require(
        config.timeoutIntervalForRequest == expected[index].0
          && config.timeoutIntervalForResource == expected[index].1, "timeout budget")
      try require(
        config.httpCookieStorage == nil && !config.httpShouldSetCookies
          && config.urlCredentialStorage == nil && config.urlCache == nil
          && config.requestCachePolicy == .reloadIgnoringLocalAndRemoteCacheData,
        "no state/cache sharing")
    }
    checks += 1

    for key in ["offline-invalid-header", "offline-oversize-body"] {
      let wire = transport!
      try await rejected(Task { try await wire.send(request(key: key), token: "offline-token") })
      try await wait { Fixture.didStop(key) }
      _ = try await wire.send(request(), token: "offline-after-rejection")
    }
    try require(factory.sessions.count == 3, "rejected response does not discard pool")
    checks += 1

    do {
      let wire = transport!
      let first = Task {
        try await wire.send(request(key: "offline-hold-first"), token: "offline-first")
      }
      let second = Task {
        try await wire.send(request(key: "offline-hold-second"), token: "offline-second")
      }
      try await wait {
        Fixture.requests().filter {
          $0.value(forHTTPHeaderField: "Idempotency-Key")?.contains("hold") == true
        }.count == 2
      }
      first.cancel()
      try await rejected(first)
      try await wait { Fixture.didStop("offline-hold-first") }
      try require(!Fixture.didStop("offline-hold-second"), "cancellation is per request")
      Fixture.finish("offline-hold-second")
      let result = try await second.value
      try require(result.body == Data("{}".utf8), "other request completes")
    }
    checks += 1

    let session = factory.sessions[0]
    let delegate = session.delegate as! URLSessionTaskDelegate
    try checkDelegate(session, delegate: delegate)
    checks += 1

    transport = nil
    try require(retainedTransport.value == nil, "pooled delegate does not retain transport")
    try checkDelegate(session, delegate: delegate, testRedirect: false)
    checks += 1
    print("native transport: \(checks) checks passed; offline URLProtocol fixture")
  }
}

private final class ChallengeSender: NSObject, URLAuthenticationChallengeSender {
  func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {}
  func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {}
  func cancel(_ challenge: URLAuthenticationChallenge) {}
}

private final class WeakTransport {
  weak var value: ProviderNativeTransport?
  init(_ value: ProviderNativeTransport) { self.value = value }
}

private func checkDelegate(
  _ session: URLSession, delegate: URLSessionTaskDelegate, testRedirect: Bool = true
) throws {
  let url = URL(string: "https://" + ProviderNativeTransport.stagingHost)!
  let challenge = URLAuthenticationChallenge(
    protectionSpace: URLProtectionSpace(
      host: "invalid.example",
      port: 443, protocol: "https", realm: nil,
      authenticationMethod: NSURLAuthenticationMethodHTTPBasic),
    proposedCredential: nil, previousFailureCount: 0, failureResponse: nil, error: nil,
    sender: ChallengeSender())
  var denied = false
  delegate.urlSession?(session, didReceive: challenge) { disposition, credential in
    denied = disposition == .cancelAuthenticationChallenge && credential == nil
  }
  try require(denied, "invalid challenge fails closed")
  guard testRedirect else { return }
  let task = session.dataTask(with: url)
  defer { task.cancel() }
  var redirected = true
  delegate.urlSession?(
    session, task: task,
    willPerformHTTPRedirection: HTTPURLResponse(
      url: url, statusCode: 302, httpVersion: nil, headerFields: nil)!,
    newRequest: URLRequest(url: URL(string: "https://invalid.example")!)
  ) { redirected = $0 != nil }
  try require(!redirected, "redirect denied")
}
