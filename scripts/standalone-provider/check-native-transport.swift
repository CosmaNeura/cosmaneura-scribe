import CosmasNativeAuth
import Foundation

// Offline URLProtocol fixture: intercepts every request before DNS/TLS. No
// account, microphone, clinical content, network or persistent store is used.
private final class Fixture: URLProtocol, @unchecked Sendable {
  static let lock = NSLock()
  nonisolated(unsafe) static var seen: [URLRequest] = []
  nonisolated(unsafe) static var held: [String: Fixture] = [:]
  nonisolated(unsafe) static var stopped: Set<String> = []
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let key = request.value(forHTTPHeaderField: "Idempotency-Key")!
    Self.lock.lock()
    Self.seen.append(request)
    if key.contains("hold") { Self.held[key] = self }
    Self.lock.unlock()
    var headers = ["Content-Type": "application/json",
                   "Cache-Control": key.contains("invalid") ? "public" : "no-store"]
    if key.contains("timing-good") { headers["Server-Timing"] = timingHeader }
    if key.contains("timing-malformed") { headers["Server-Timing"] = "private-forbidden-header" }
    if key.contains("timing-good") { headers["X-Scribe-Core-Timing"] = coreTimingHeader }
    if key.contains("timing-malformed") { headers["X-Scribe-Core-Timing"] = "private-forbidden-header" }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: key.contains("not-found") ? 404 : 200, httpVersion: "HTTP/1.1",
      headerFields: headers)!
    client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    if key.contains("opening-long") {
      let data = Data(("{\"padding\":\"" + String(repeating: "x", count: 9000) + "\"}").utf8)
      client!.urlProtocol(self, didLoad: data)
      client!.urlProtocolDidFinishLoading(self)
    } else if key.contains("oversize") {
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
private func wait(_ condition: @Sendable () -> Bool) async throws {
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

private let timingHeader = ProviderServerTiming.Phase.allCases.map {
  "scribe_\($0.rawValue);dur=123.456"
}.joined(separator: ", ")
private let coreTimingHeader = "v=1;observations=3;accepted=1;missing=1;invalid=1;response_start_only=1;nonadditive=1;workflow_token_ms=12.25;workflow_token_count=1;workflow_token_failures=0;workflow_http_ms=47.50;workflow_http_count=2;workflow_http_failures=1;capture_transaction_ms=88.75;capture_transaction_count=1;capture_transaction_failures=0"

private func checkTimingMetadata() throws {
  let expected = ProviderServerTiming.parse([timingHeader])
  try require(expected?.milliseconds(.registry) == 123.456, "fixed numeric header")
  try require(expected?.milliseconds(.total) == 123.456, "total retained")
  for invalid in [
    [], [timingHeader, timingHeader], [timingHeader + ", " + timingHeader],
    [timingHeader.replacingOccurrences(of: "scribe_core_mount", with: "private_identity")],
    [timingHeader.replacingOccurrences(of: "scribe_core_mount", with: "scribe_registry")],
    [String(timingHeader.split(separator: ",").dropLast().joined(separator: ","))],
    [timingHeader + ";desc=private"], [String(repeating: "x", count: 513)],
  ] {
    try require(ProviderServerTiming.parse(invalid) == nil, "closed header vocabulary")
  }
  for invalid in ["-1", "NaN", "inf", "1e3", "3600000.001", "123.4567", "+1", "private", "", "1\n"] {
    try require(ProviderServerTiming.parse([timingHeader.replacingOccurrences(of: "123.456", with: invalid)]) == nil,
                "invalid duration discarded")
  }
  let response = HTTPURLResponse(url: URL(string: "https://synthetic.invalid")!, statusCode: 200,
    httpVersion: "HTTP/1.1", headerFields: ["Server-Timing":timingHeader,"Unrelated":"private-forbidden"])!
  try require(ProviderServerTiming.from(response) == expected, "only fixed header extracted")
  let core = ProviderCoreTiming.parse([coreTimingHeader])
  try require(core?.measurement(.workflow_http).milliseconds == 47.5, "optional numeric phase")
  try require(core?.measurement(.workflow_http).failures == 1, "optional failure count")
  try require(core?.observations == 3 && core?.missing == 1, "explicit incomplete observations")
  for invalid in [
    [], [coreTimingHeader, coreTimingHeader], [coreTimingHeader + ";v=1"],
    [coreTimingHeader.replacingOccurrences(of: "workflow_http_ms", with: "private_identity")],
    [coreTimingHeader.replacingOccurrences(of: "v=1", with: "v=2")],
    [coreTimingHeader.replacingOccurrences(of: "response_start_only=1", with: "response_start_only=0")],
    [coreTimingHeader.replacingOccurrences(of: "nonadditive=1", with: "nonadditive=0")],
    [coreTimingHeader.replacingOccurrences(of: "observations=3", with: "observations=16")],
    [coreTimingHeader.replacingOccurrences(of: "accepted=1", with: "accepted=0")],
    [coreTimingHeader.replacingOccurrences(of: "workflow_http_count=2", with: "workflow_http_count=10001")],
    [coreTimingHeader.replacingOccurrences(of: "workflow_http_failures=1", with: "workflow_http_failures=3")],
    [String(repeating: "x", count: 1025)],
  ] {
    try require(ProviderCoreTiming.parse(invalid) == nil, "closed optional numeric vocabulary")
  }
  for invalid in ["-1", "NaN", "inf", "1e3", "600000.001", "123.4567", "+1", "true", "", "1\n"] {
    try require(ProviderCoreTiming.parse([coreTimingHeader.replacingOccurrences(of: "47.50", with: invalid)]) == nil,
                "invalid optional duration discarded")
  }
  let both = HTTPURLResponse(url: URL(string: "https://synthetic.invalid")!, statusCode: 200,
    httpVersion: "HTTP/1.1", headerFields: ["Server-Timing": timingHeader, "X-Scribe-Core-Timing": coreTimingHeader])!
  try require(ProviderCoreTiming.from(both) == core && ProviderServerTiming.from(both) == expected,
              "legacy eight metrics unaffected by optional header")
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
    try checkTimingMetadata(); checks += 1

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

    do {
      let wire = transport!
      let combined = try ProviderNativeRequest(nativeStartID: UUID(),
        revision: UUID().uuidString.lowercased(), key: "offline-not-found-combined",
        body: Data("{}".utf8), combinedPreparation: true)
      let result = try await wire.send(combined, token: "offline-native-token")
      try require(result.status == 404, "new native route can explicitly report unsupported")
      try require(Fixture.requests().last!.url!.path == "/provider/v1/source-start-ready", "fixed route")
      try await rejected(Task {
        try await wire.send(request(key: "offline-not-found-recorder"), token: "offline-token")
      })
      let legacy = try ProviderNativeRequest(nativeStartID: UUID(),
        revision: UUID().uuidString.lowercased(), key: "offline-not-found-legacy", body: Data("{}".utf8))
      try await rejected(Task { try await wire.send(legacy, token: "offline-token") })
      checks += 1
    }

    for action in ["capture-admissions", "capture-notes", "capture-admissions", "capture-notes", "note-opening"] {
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
      let body = String(
        decoding: try JSONSerialization.data(withJSONObject: [
          "workspace_id": UUID().uuidString.lowercased(),
          "opening_nonce": UUID().uuidString.lowercased(),
        ]), as: UTF8.self)
      let opening = try ProviderNativeRequest(
        id: UUID().uuidString.lowercased(),
        revision: UUID().uuidString.lowercased(), action: "mount", key: "offline-opening-long",
        body: body)
      let reply = try await wire.send(opening, token: "offline-opening-token")
      try require(reply.body.count > 8192, "combined opening streams its bounded larger body")
      try await rejected(
        Task {
          try await wire.send(
            request("mount", key: "offline-opening-long-legacy"), token: "offline-legacy-token")
        })
      checks += 1
    }

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

    for key in ["offline-timing-good", "offline-timing-malformed", "offline-timing-missing"] {
      let reply = try await transport!.send(request(key: key), token: "offline-timing-token")
      try require(reply.status == 200 && reply.body == Data("{}".utf8), "diagnostics never change response")
      try require(reply.serverTiming == (key.contains("good") ? ProviderServerTiming.parse([timingHeader]) : nil),
                  "actual URLProtocol header reaches only its own reply")
      try require(reply.coreTiming == (key.contains("good") ? ProviderCoreTiming.parse([coreTimingHeader]) : nil),
                  "optional URLProtocol timing never inherits a previous reply")
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
