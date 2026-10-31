import CosmaneuraIOSAVFoundationDriver
import CosmaneuraIOSPCMCore
import CosmasNativeAuth
import Foundation
import Security

@testable import CosmaneuraNativeRecording
@testable import CosmaneuraNativeRecordingPCM

private struct RunCheckFailure: Error { let line: UInt }
private func runRequire(_ value: Bool, line: UInt = #line) throws {
  if !value { throw RunCheckFailure(line: line) }
}

// Synthetic consent/source metadata and fake audio only. No microphone, meeting,
// Keychain, user session or service is accessed by this executable.
private final class FinalizationWrites: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.withLock { value } }
  func increment() { lock.withLock { value += 1 } }
}

@MainActor private final class Idle {
  var value = true
}

@MainActor private final class Source: NativeProviderMicrophoneSource {
  let recordingPreparation: NativeSourcePreparation
  let runID = UUID().uuidString.lowercased()
  var prepared = 0, issued = 0, stopped = 0
  var retired = false, hardRetired = false, stopFails = false
  var holdPrepare = false, holdAuthorize = false
  var prepareWait: CheckedContinuation<Void, Never>?
  var authorizeWait: CheckedContinuation<Void, Never>?
  init(_ preparation: NativeSourcePreparation) { recordingPreparation = preparation }
  var grant: NativeSourceGrant {
    NativeSourceGrant(
      captureSessionID: recordingPreparation.sessionID.uuidString.lowercased(),
      actorID: "synthetic-provider", consentRecordID: UUID().uuidString.lowercased(),
      sourceLeaseID: runID, source: .ios)
  }
  func prepare() async throws -> NativeSourceGrant {
    prepared += 1
    if holdPrepare { await withCheckedContinuation { prepareWait = $0 } }
    guard !retired else { throw ProviderNativeError.unavailable }
    return grant
  }
  func consumeForMicrophone() async throws -> NativeCapturePermit {
    _ = try await prepare()
    issued += 1
    if holdAuthorize { await withCheckedContinuation { authorizeWait = $0 } }
    // Deliberately returns even after retirement: the shared gate must fence it.
    return try NativeCapturePermit(
      runID: runID, startExpiresAt: Date().addingTimeInterval(10),
      captureExpiresAt: ISO8601DateFormatter().date(
        from: recordingPreparation.captureAuthorizedUntil)!)
  }
  func requireActiveMicrophone(runID: String) throws {
    guard issued == 1, !retired, runID == self.runID else {
      throw ProviderNativeError.authorityChanged
    }
  }
  func requireMicrophoneFinalization(runID: String) throws {
    guard issued == 1, !hardRetired, runID == self.runID else {
      throw ProviderNativeError.authorityChanged
    }
  }
  func retireForStop() { retired = true }
  func retireForAuthenticationChange() { retired = true; hardRetired = true }
  func confirmStopped() async throws {
    stopped += 1
    if stopFails || prepareWait != nil { throw ProviderNativeError.unavailable }
  }
}

@MainActor private final class Recorder: NativeProviderEncryptedRecorder {
  var isPhysicallyIdle = true
  var capturedAudioFrames = 0
  var starts = 0, stops = 0, readyCalls = 0
  var holdReady = false, stopFails = false, terminal = false, startFails = false
  var readyWait: CheckedContinuation<Void, Never>?
  var invalidations = 0
  var incomplete = false
  var validate: (@Sendable () async throws -> Void)?
  var finalize: NativeRecordingFinalizer?
  var finalizationWrites = 0
  let signal = PCMSignalMonitor()
  var captureState: NativeRecordingPCMState {
    NativeRecordingPCMState(
      phase: .closed, nextSequence: 0, committedChunks: 0,
      committedPlaintextBytes: 0, pendingReservations: 0)
  }
  func start(
    runID: String, captureExpiresAtMilliseconds: Int64,
    lease: NativeRecordingLease, batch: NativeRecordingReservationBatch
  ) throws {
    starts += 1
    isPhysicallyIdle = false
    if startFails { throw ProviderNativeError.unavailable }
  }
  func ready() async throws {
    readyCalls += 1
    if holdReady { await withCheckedContinuation { readyWait = $0 } }
    try await validate?()
  }
  func stop() async throws {
    stops += 1
    if stopFails { throw ProviderNativeError.unavailable }
    isPhysicallyIdle = true
    if incomplete { throw NativeRecordingFinalizationFailure.storageFailed }
  }
  func invalidatePendingAudio() { invalidations += 1 }
  func snapshot() async -> NativeRecordingContinuationState? {
    NativeRecordingContinuationState(
      phase: terminal ? .failed : .recording, reason: nil,
      sourceGeneration: 1, reservedThroughSequence: 90, capture: captureState)
  }
  func captureSignal() -> PCMSignalMonitor.Snapshot { signal.snapshot() }
}

@MainActor private struct Fixture {
  let lease: NativeRecordingLease
  let batch: NativeRecordingReservationBatch
  let preparation: NativeSourcePreparation
  let source: Source
  let recorder = Recorder()
  init() throws {
    let scope = try NativeRecordingScope(
      tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
      accountDigest: String(repeating: "a", count: 64))
    let now = Date()
    let format = ISO8601DateFormatter()
    let object = UUID()
    lease = try NativeRecordingLease(
      receiptID: UUID(), leaseID: UUID(), sessionID: scope.sessionID,
      generation: 1, issuedAt: format.string(from: now),
      expiresAt: format.string(from: now.addingTimeInterval(900)))
    let reservation = try NativeRecordingReservation(
      scope: scope, objectID: object, sequence: 0,
      additionalData: nativeBase64URL(scope.additionalData(objectID: object, sequence: 0)),
      createdAt: lease.issuedAt)
    batch = NativeRecordingReservationBatch(
      batchID: UUID(), sessionID: scope.sessionID,
      authorizedUntil: lease.expiresAt, reservations: [reservation])
    preparation = try NativeSourcePreparation(
      workspaceID: scope.workspaceID,
      bindingRef: "scribe_capture_binding_01j00000000000000000000000", sessionID: scope.sessionID,
      leaseID: lease.leaseID, leaseReceiptID: lease.receiptID, leaseGeneration: 1,
      captureAuthorizedUntil: lease.expiresAt, source: .ios)
    source = Source(preparation)
  }
  func run(permission: @escaping @MainActor () async throws -> Bool = { true }) throws
    -> NativeProviderRecordingRun
  {
    try NativeProviderRecordingRun(
      source: source, lease: lease, batch: batch, requestPermission: permission
    ) { validate, finalize in
      recorder.validate = validate
      recorder.finalize = finalize
      return recorder
    }
  }
}

@MainActor private final class JournalMemory: NativeSourceJournalBacking {
  var data: Data?
  var fail = false
  func read() throws -> Data? { data }
  func write(_ value: Data) throws {
    if fail { throw NativeSourceJournalError.unavailable }
    data = value
  }
}

private actor SourceWire: ProviderNativeWire {
  let preparation: NativeSourcePreparation
  let sourceID = UUID().uuidString.lowercased(), consentID = UUID().uuidString.lowercased()
  let capabilityID = UUID().uuidString.lowercased()
  var stopAttempts: [(String, Data)] = []
  var requests: [ProviderNativeRequest] = []
  var loseStop = false
  var sequenceStatus = 200, fault = "none", holdSequence = false
  private var held: CheckedContinuation<Void, Never>?
  private var entered: CheckedContinuation<Void, Never>?
  init(_ preparation: NativeSourcePreparation) { self.preparation = preparation }
  func loseNextStop() { loseStop = true }
  func configure(status: Int = 200, fault: String = "none", hold: Bool = false) {
    sequenceStatus = status; self.fault = fault; holdSequence = hold
  }
  func waitUntilHeld() async {
    if held == nil { await withCheckedContinuation { entered = $0 } }
  }
  func release() { held?.resume(); held = nil }
  func send(_ request: ProviderNativeRequest, token: String) async throws -> ProviderNativeReply {
    requests.append(request)
    let body = try JSONSerialization.jsonObject(with: request.body) as! [String: Any]
    let operation = body["operation"] as! [String: Any]
    let action = operation["action"] as! String
    let payload = operation["payload"] as! [String: Any]
    if request.action == .sourceStartReady {
      if holdSequence {
        await withCheckedContinuation { held = $0; entered?.resume(); entered = nil }
      }
      if fault == "lost" { throw ProviderNativeError.unavailable }
      if sequenceStatus != 200 {
        return ProviderNativeReply(status: sequenceStatus, body: Data("{}".utf8))
      }
      var prepared = response(action: "prepare", body: body)
      var authorizeBody = body
      authorizeBody["request_nonce"] = body["authorize_request_nonce"]!
      var authorized = response(action: "authorize", body: authorizeBody)
      var preparationReceipt = prepared["receipt"] as! [String: Any]
      var authorization = authorized["receipt"] as! [String: Any]
      var receipt = authorization["receipt"] as! [String: Any]
      switch fault {
      case "prepare-nonce": prepared["request_nonce"] = UUID().uuidString.lowercased()
      case "authorize-nonce": authorized["request_nonce"] = UUID().uuidString.lowercased()
      case "prepare-state": preparationReceipt["state"] = "issued"
      case "prepare-session": preparationReceipt["session_id"] = UUID().uuidString.lowercased()
      case "prepare-expired": preparationReceipt["preparation_expires_at"] = "2000-01-01T00:00:00Z"
      case "authorize-secret": authorization["secret"] = "different-proof"
      case "authorize-source": receipt["source_start_id"] = UUID().uuidString.lowercased()
      case "authorize-consent": receipt["consent_record_id"] = UUID().uuidString.lowercased()
      case "authorize-expired": receipt["expires_at"] = "2000-01-01T00:00:00Z"
      case "authorize-position": receipt["first_sequence_number"] = 2
      default: break
      }
      prepared["receipt"] = preparationReceipt
      authorization["receipt"] = receipt
      authorized["receipt"] = authorization
      return ProviderNativeReply(status: 200, body: try JSONSerialization.data(withJSONObject: [
        "preparation": prepared, "authorization": authorized,
      ]))
    }
    if action == "stop" {
      // Canonicalize only the original proof payload; each envelope nonce is new.
      stopAttempts.append(
        (request.key, try JSONSerialization.data(withJSONObject: payload, options: .sortedKeys)))
      if loseStop {
        loseStop = false
        throw ProviderNativeError.unavailable
      }
    }
    var value = response(action: action, body: body)
    if action == "prepare", fault == "prepare-deadline" {
      var receipt = value["receipt"] as! [String: Any]
      let format = ISO8601DateFormatter()
      receipt["preparation_expires_at"] = format.string(
        from: format.date(from: preparation.captureAuthorizedUntil)!.addingTimeInterval(1))
      value["receipt"] = receipt
    }
    return ProviderNativeReply(status: 200,
      body: try JSONSerialization.data(withJSONObject: value))
  }
  private func response(action: String, body: [String: Any]) -> [String: Any] {
    let operation = body["operation"] as! [String: Any]
    let payload = operation["payload"] as! [String: Any]
    let now = Date()
    let format = ISO8601DateFormatter()
    let expires = format.string(
      from: min(
        now.addingTimeInterval(10),
        format.date(from: preparation.captureAuthorizedUntil)!))
    var receipt: [String: Any] = [
      "schema_version": "1.0", "session_id": preparation.sessionID.uuidString.lowercased(),
      "attempt_id": payload["attempt_id"]!, "source_start_id": sourceID,
      "creator_actor_id": "synthetic-provider", "consent_record_id": consentID,
      "source": "ios_microphone", "lease_id": preparation.leaseID.uuidString.lowercased(),
      "lease_receipt_id": preparation.leaseReceiptID.uuidString.lowercased(),
      "lease_generation": preparation.leaseGeneration,
      "state": action == "prepare" ? "prepared"
        : (action == "stop" ? "stopped" : (action == "cancel" ? "cancelled" : "issued")),
      "preparation_expires_at": format.string(from: now.addingTimeInterval(60)),
      "capture_authorized_until": preparation.captureAuthorizedUntil,
      "issued_at": action == "prepare" ? NSNull() : format.string(from: now),
      "expires_at": action == "prepare" ? NSNull() : expires, "capability_id": capabilityID,
    ]
    if preparation.firstSequenceNumber > 0 {
      receipt["first_sequence_number"] = preparation.firstSequenceNumber
    }
    let result: [String: Any] =
      action == "authorize" ? ["receipt": receipt, "secret": payload["owner_proof"]!] : receipt
    return [
        "contract_version": "1", "operation": "source_start", "workspace_id": body["workspace_id"]!,
        "binding_ref": body["binding_ref"]!, "request_nonce": body["request_nonce"]!,
        "checked_at": format.string(from: now), "receipt": result,
      ]
  }
}

@MainActor private struct BoundSource {
  let fixture: Fixture
  let driver = Driver()
  let journal: NativeSourceProofJournal
  let wire: SourceWire
  let auth: NativeWorkspaceAuth
  let source: NativeSourceStartOwner
  let connection: NativeProviderConnection
  init() throws {
    fixture = try Fixture()
    journal = try NativeSourceProofJournal(platform: .ios, backing: JournalMemory())
    wire = SourceWire(fixture.preparation)
    let policy = try NativeTokenPolicy(
      issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider")
    let driver = driver
    auth = NativeWorkspaceAuth(
      enabled: true, organizationID: "org_offline", tokenPolicy: policy,
      driver: { driver }, accessBlock: { Block() })
    connection = NativeProviderConnection(auth: auth, wire: wire)
    let connection = connection
    auth.onChange = { [weak connection] state in connection?.authChanged(state) }
    source = try NativeSourceStartOwner(
      connection: connection, revision: auth.state().revision,
      preparation: fixture.preparation, identity: auth.state().identity!, journal: journal)
  }
  func run(permission: @escaping @MainActor () async throws -> Bool = { true }) throws
    -> NativeProviderRecordingRun
  {
    try NativeProviderRecordingRun(
      source: source, lease: fixture.lease, batch: fixture.batch, requestPermission: permission
    ) { validate, finalize in
      fixture.recorder.validate = validate
      fixture.recorder.finalize = finalize
      return fixture.recorder
    }
  }
}

@main private struct CheckNativeRecordingRun {
  @MainActor static func rejects(
    line: UInt = #line, _ operation: @MainActor () async throws -> Void
  ) async throws {
    do { try await operation() } catch { return }
    throw RunCheckFailure(line: line)
  }
  @MainActor static func wait(line: UInt = #line, _ condition: @MainActor () -> Bool) async throws {
    for _ in 0..<3000 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(1))
    }
    throw RunCheckFailure(line: line)
  }
  @MainActor static func main() async throws {
    var checks = 0
    // Missing legacy probe cannot prove that all native audio has stopped.
    try await rejects {
      try NativeCaptureStartGate.install(owner: UUID()) { throw ProviderNativeError.unavailable }
    }
    checks += 1
    let legacy = Idle()
    NativeCaptureStartGate.registerIdleProbe { legacy.value }
    do {
      let owner = UUID()
      let runID = UUID().uuidString.lowercased()
      var issued = 0
      try NativeCaptureStartGate.install(owner: owner) {
        issued += 1
        return try NativeCapturePermit(
          runID: runID, startExpiresAt: Date().addingTimeInterval(10),
          captureExpiresAt: Date().addingTimeInterval(900))
      }
      try runRequire(NativeCaptureStartGate.startTicket() == owner)
      try await rejects {
        try await NativeCaptureStartGate.consume(owner: owner, consumer: .nativeEncryptedMicrophone)
        { _ in }
      }
      try runRequire(issued == 0)
      try await NativeCaptureStartGate.consume(owner: owner) { _ in legacy.value = false }
      NativeCaptureStartGate.clear(owner: owner)
      try await rejects { try NativeCaptureStartGate.confirmStopped(owner: owner) }
      try await rejects { try await NativeCaptureStartGate.recoverWhileIdle {} }
      legacy.value = true
      try NativeCaptureStartGate.confirmStopped(owner: owner)
      NativeCaptureStartGate.clear(owner: owner)
      try await NativeCaptureStartGate.recoverWhileIdle {}
      try runRequire(issued == 1)
      checks += 5
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      try await run.start()
      try runRequire(
        run.phase == .recording && fixture.recorder.starts == 1 && fixture.source.issued == 1)
      try await fixture.recorder.validate?()
      try await rejects { _ = try NativeCaptureStartGate.startTicket() }
      try await rejects { try await run.start() }
      // A plugin reload adds its probe; it cannot overwrite the old active probe.
      legacy.value = false
      NativeCaptureStartGate.registerIdleProbe { true }
      try await rejects { try await run.stop() }
      try runRequire(run.phase == .stopPending && fixture.source.stopped == 0)
      legacy.value = true
      try await run.stop()
      try runRequire(run.phase == .stopped && fixture.source.stopped == 1)
      try await NativeCaptureStartGate.recoverWhileIdle {}
      checks += 5
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      fixture.recorder.stopFails = true
      try await run.start()
      try await rejects { try await run.stop() }
      try runRequire(run.failure == .physicalStopPending && fixture.source.stopped == 0)
      let other = try Fixture()
      let replacement = try other.run()
      try await rejects { try await replacement.start() }
      fixture.recorder.stopFails = false
      try await run.stop()
      try runRequire(
        run.phase == .stopped && fixture.recorder.stops == 2 && fixture.source.stopped == 1)
      try await replacement.start()
      try await replacement.stop()
      checks += 3
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      try await run.start()
      fixture.recorder.incomplete = true
      for _ in 0..<2 { try await rejects { try await run.stop() } }
      try runRequire(run.phase == .stopped && run.isPhysicallyIdle)
      try runRequire(run.failure == .recordingIncomplete && fixture.source.stopped == 1)
      try await rejects { try await run.start() }
      try await NativeCaptureStartGate.recoverWhileIdle {}
      checks += 1
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      try await run.start()
      let finalize = fixture.recorder.finalize!
      let writes = FinalizationWrites()
      try await finalize { writes.increment() }
      try runRequire(writes.count == 1)
      run.retire()
      try runRequire(fixture.recorder.invalidations == 1)
      try await rejects { try await finalize { writes.increment() } }
      try await run.stop()
      try runRequire(writes.count == 1)
      checks += 1
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      fixture.source.stopFails = true
      try await run.start()
      try await rejects { try await run.stop() }
      try runRequire(run.failure == .sourceStopPending && run.isPhysicallyIdle)
      try await rejects { try await NativeCaptureStartGate.recoverWhileIdle {} }
      fixture.source.stopFails = false
      try await run.stop()
      try runRequire(fixture.source.stopped == 2 && fixture.source.issued == 1)
      checks += 3
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run(permission: { false })
      try await rejects { try await run.start() }
      try runRequire(
        fixture.source.prepared == 0 && fixture.source.issued == 0 && fixture.recorder.starts == 0)
      try runRequire(run.phase == .stopped && fixture.source.stopped == 1)
      checks += 2
    }
    do {
      let fixture = try Fixture()
      var permission: CheckedContinuation<Bool, Never>?
      let run = try fixture.run { await withCheckedContinuation { permission = $0 } }
      let start = Task { try await run.start() }
      try await wait { permission != nil }
      try await run.stop()
      permission?.resume(returning: true)
      try await rejects { try await start.value }
      try runRequire(
        fixture.source.prepared == 0 && fixture.recorder.starts == 0 && run.phase == .stopped)
      checks += 2
    }
    for stalled in ["prepare", "authorize", "ready"] {
      let fixture = try Fixture()
      let run = try fixture.run()
      fixture.source.holdPrepare = stalled == "prepare"
      fixture.source.holdAuthorize = stalled == "authorize"
      fixture.recorder.holdReady = stalled == "ready"
      let start = Task { try await run.start() }
      try await wait {
        fixture.source.prepareWait != nil || fixture.source.authorizeWait != nil
          || fixture.recorder.readyWait != nil
      }
      if stalled == "ready" {
        try await run.stop()
      } else {
        try await rejects { try await run.stop() }
      }
      fixture.source.prepareWait?.resume()
      fixture.source.prepareWait = nil
      fixture.source.authorizeWait?.resume()
      fixture.source.authorizeWait = nil
      fixture.recorder.readyWait?.resume()
      fixture.recorder.readyWait = nil
      try await rejects { try await start.value }
      try await run.stop()
      try runRequire(
        run.phase == .stopped && fixture.recorder.starts == (stalled == "ready" ? 1 : 0))
      checks += 2
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      fixture.recorder.startFails = true
      try await rejects { try await run.start() }
      try runRequire(
        run.phase == .stopped && fixture.recorder.stops == 1 && fixture.source.stopped == 1)
      checks += 1
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      try await run.start()
      run.retire()
      try await rejects { try await fixture.recorder.validate?() }
      try await wait { run.phase == .stopped }
      try runRequire(fixture.source.issued == 1 && fixture.recorder.stops == 1)
      checks += 2
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      fixture.recorder.terminal = true
      try await run.start()
      try await wait { run.phase == .stopped }
      try runRequire(fixture.source.stopped == 1 && fixture.recorder.stops == 1)
      checks += 1
    }
    do {
      let fixture = try Fixture()
      let run = try fixture.run()
      // Repeated start/readiness requests join one operation while it is pending.
      fixture.recorder.holdReady = true
      let first = Task { try await run.start() }
      try await wait { fixture.recorder.readyWait != nil }
      let second = Task { try await run.start() }
      await Task.yield()
      fixture.recorder.readyWait?.resume()
      fixture.recorder.readyWait = nil
      try await first.value
      try await second.value
      try runRequire(fixture.recorder.starts == 1 && fixture.recorder.readyCalls == 1)
      async let stop1: Void = run.stop()
      async let stop2: Void = run.stop()
      _ = try await (stop1, stop2)
      try runRequire(fixture.recorder.stops == 1 && fixture.source.stopped == 1)
      checks += 2
    }
    do {
      let fixture = try Fixture()
      let other = try Fixture()
      try await rejects {
        _ = try NativeProviderRecordingRun(
          source: fixture.source, lease: other.lease, batch: other.batch,
          requestPermission: { true }, makeRecorder: { _, _ in fixture.recorder })
      }
      // A source whose construction persisted proof still retires if never started.
      let run = try fixture.run()
      try await run.stop()
      try runRequire(
        fixture.source.issued == 0 && fixture.source.stopped == 1 && run.phase == .stopped)
      checks += 2
    }
    // Real source proof, Core envelope validation and native account owner.
    do {
      let fixture = try Fixture()
      let memory = JournalMemory()
      let journal = try NativeSourceProofJournal(platform: .ios, backing: memory)
      let driver = Driver()
      let block = Block()
      let wire = SourceWire(fixture.preparation)
      let policy = try NativeTokenPolicy(
        issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider")
      let auth = NativeWorkspaceAuth(
        enabled: true, organizationID: "org_offline", tokenPolicy: policy,
        driver: { driver }, accessBlock: { block })
      let connection = NativeProviderConnection(auth: auth, wire: wire)
      auth.onChange = { [weak connection] state in connection?.authChanged(state) }
      let revision = auth.state().revision
      let source = try NativeSourceStartOwner(
        connection: connection, revision: revision,
        preparation: fixture.preparation, identity: auth.state().identity!, journal: journal)
      let original = journal.pending
      try await rejects { try source.requireActiveMicrophone(runID: wire.sourceID) }
      let run = try NativeProviderRecordingRun(
        source: source, lease: fixture.lease, batch: fixture.batch,
        requestPermission: { true },
        makeRecorder: { validate, _ in
          fixture.recorder.validate = validate
          return fixture.recorder
        })
      try await run.start()
      try await fixture.recorder.validate?()
      try runRequire(journal.pending == original && journal.pending.count == 1)
      try await rejects {
        try source.requireActiveMicrophone(runID: UUID().uuidString.lowercased())
      }
      await wire.loseNextStop()
      try await rejects { try await run.stop() }
      try runRequire(
        journal.pending == original && run.phase == .stopPending && run.isPhysicallyIdle)
      try await run.stop()
      let attempts = await wire.stopAttempts
      try runRequire(
        journal.pending.isEmpty && attempts.count == 2 && attempts[0].0 == attempts[1].0
          && attempts[0].1 == attempts[1].1)
      checks += 5
    }
    for change in ["different-account", "same-account-new-session", "retired"] {
      let fixture = try Fixture()
      let journal = try NativeSourceProofJournal(platform: .ios, backing: JournalMemory())
      let driver = Driver()
      let wire = SourceWire(fixture.preparation)
      let policy = try NativeTokenPolicy(
        issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider")
      let auth = NativeWorkspaceAuth(
        enabled: true, organizationID: "org_offline", tokenPolicy: policy,
        driver: { driver }, accessBlock: { Block() })
      let connection = NativeProviderConnection(auth: auth, wire: wire)
      let source = try NativeSourceStartOwner(
        connection: connection, revision: auth.state().revision,
        preparation: fixture.preparation, identity: auth.state().identity!, journal: journal)
      _ = try await source.prepare()
      let permit = try await source.consumeForMicrophone()
      try source.requireActiveMicrophone(runID: permit.runID)
      if change == "retired" {
        source.retireForAuthenticationChange()
      } else {
        driver.identity = try NativeAuthIdentity(
          userID: change == "different-account" ? "user_other" : "user_offline",
          sessionID: "sess_replacement", organizationID: "org_offline")
      }
      try await rejects { try source.requireActiveMicrophone(runID: permit.runID) }
      // Original proof remains intact even if authorization was lost.
      try runRequire(journal.pending.count == 1)
      checks += 2
    }
    checks += try await checkSourceSequence()
    checks += try await checkActualEncryptedRun()
    checks += try NativePassageSelectionChecks.run()
    checks += try await CheckNativeRecordingHost.run()
    print("native recording run checks passed: \(checks)")
  }

  @MainActor static func checkSourceSequence() async throws -> Int {
    var checks = 0
    do {
      let f = try BoundSource()
      try await f.source.prepareRecordingReady()
      let before = await f.wire.requests
      try runRequire(before.count == 1 && before[0].action == .sourceStart)
      let body = try JSONSerialization.jsonObject(with: before[0].body) as! [String: Any]
      try runRequire((body["operation"] as! [String: Any])["action"] as? String == "prepare")
      try runRequire(f.source.preparationExpiresAt! > Date() && f.fixture.recorder.starts == 0)
      let run = try f.run()
      try await run.start()
      let requests = await f.wire.requests
      try runRequire(requests.map(\.action) == [.sourceStart, .sourceStart])
      let authorization = try JSONSerialization.jsonObject(with: requests[1].body) as! [String: Any]
      try runRequire((authorization["operation"] as! [String: Any])["action"] as? String == "authorize")
      try runRequire(f.fixture.recorder.starts == 1)
      try await run.stop(); try runRequire(f.journal.pending.isEmpty)
      checks += 7
    }
    do {
      let f = try BoundSource()
      await f.wire.configure(fault: "prepare-deadline")
      try await rejects { try await f.source.prepareRecordingReady() }
      try runRequire(f.source.preparationExpiresAt == nil && f.fixture.recorder.starts == 0)
      try runRequire(await f.wire.requests.count == 1 && f.journal.pending.count == 1)
      try await f.source.confirmStopped(); checks += 3
    }
    do {
      let f = try BoundSource(), original = try BoundSource()
      // The new string action must never be available to renderer callers.
      try await rejects {
        _ = try ProviderNativeRequest(id: UUID().uuidString.lowercased(),
          revision: f.auth.state().revision, action: "source-start-ready", key: "synthetic-start", body: "{}")
      }
      let pending = f.journal.pending
      let run = try f.run()
      try await run.start()
      try runRequire(await f.wire.requests.count == 1)
      try runRequire(await f.wire.requests.first?.action == .sourceStartReady)
      try runRequire(f.fixture.recorder.starts == 1 && f.journal.pending == pending)
      try await rejects { _ = try await f.source.consumeForMicrophone() }
      try runRequire(await f.wire.requests.count == 1)
      try await run.stop()
      try runRequire(f.journal.pending.isEmpty && original.journal.pending.count == 1)
      try await original.source.confirmStopped()
      checks += 6
    }
    do {
      let f = try BoundSource()
      await f.wire.configure(status: 404)
      let run = try f.run()
      try await run.start()
      let requests = await f.wire.requests
      try runRequire(requests.map(\.action) == [.sourceStartReady, .sourceStart, .sourceStart])
      let first = try JSONSerialization.jsonObject(with: requests[0].body) as! [String: Any]
      try runRequire(requests[0].key == requests[1].key)
      try runRequire(first["authorize_idempotency_key"] as? String == requests[2].key)
      let payloads = try requests.map { request -> Data in
        let body = try JSONSerialization.jsonObject(with: request.body) as! [String: Any]
        let operation = body["operation"] as! [String: Any]
        return try JSONSerialization.data(withJSONObject: operation["payload"]!, options: .sortedKeys)
      }
      try runRequire(payloads[0] == payloads[1] && payloads[1] == payloads[2])
      try await run.stop()
      checks += 4
    }
    for status in [401, 403, 409, 422, 503, 302, 500] {
      let f = try BoundSource()
      await f.wire.configure(status: status)
      try await rejects { _ = try await f.source.consumeForMicrophone() }
      try runRequire(await f.wire.requests.count == 1)
      try runRequire(f.journal.pending.count == 1 && f.fixture.recorder.starts == 0)
      try await f.source.confirmStopped()
      checks += 2
    }
    for fault in ["lost", "prepare-nonce", "authorize-nonce", "prepare-state", "prepare-session",
                  "prepare-expired", "authorize-secret", "authorize-source", "authorize-consent",
                  "authorize-expired", "authorize-position"] {
      let f = try BoundSource()
      await f.wire.configure(fault: fault)
      try await rejects { _ = try await f.source.consumeForMicrophone() }
      try runRequire(await f.wire.requests.count == 1)
      try runRequire(f.journal.pending.count == 1 && f.fixture.recorder.starts == 0)
      try await f.source.confirmStopped()
      checks += 2
    }
    do {
      let f = try BoundSource()
      await f.wire.configure(hold: true)
      let run = try f.run(), start = Task { try await run.start() }
      await f.wire.waitUntilHeld()
      try await rejects { try await run.stop() }
      try runRequire(f.journal.pending.count == 1 && f.fixture.recorder.starts == 0)
      await f.wire.release()
      try await rejects { try await start.value }
      try await run.stop()
      try runRequire(run.phase == .stopped && f.journal.pending.isEmpty && f.fixture.recorder.starts == 0)
      checks += 2
    }
    do {
      let f = try BoundSource()
      await f.wire.configure(hold: true)
      let identity = f.driver.identity
      let start = Task { try await f.source.consumeForMicrophone() }
      await f.wire.waitUntilHeld()
      f.driver.identity = nil
      _ = f.auth.state()
      await f.wire.release()
      try await rejects { _ = try await start.value }
      try runRequire(f.journal.pending.count == 1)
      f.driver.identity = identity
      _ = f.auth.state()
      try await f.source.confirmStopped()
      checks += 1
    }
    do {
      let f = try BoundSource()
      let run = try f.run()
      try await run.start()
      let finalize = f.fixture.recorder.finalize!, writes = FinalizationWrites()
      // Ordinary stopping fences any new capture but may retain already captured
      // PCM under this exact source. A real auth revision change still wins.
      f.source.retireForStop()
      try await finalize { writes.increment() }
      let identity = f.driver.identity
      f.driver.identity = nil
      _ = f.auth.state()
      try await rejects { try await finalize { writes.increment() } }
      f.driver.identity = identity
      _ = f.auth.state()
      try await rejects { try await finalize { writes.increment() } }
      try runRequire(writes.count == 1 && f.journal.pending.count == 1)
      try await run.stop()
      try runRequire(f.journal.pending.isEmpty)
      checks += 1
    }
    do {
      let f = try BoundSource()
      let runID = await f.wire.sourceID
      try await rejects { try f.source.requireMicrophoneFinalization(runID: runID) }
      let run = try f.run()
      try await run.start()
      try await rejects {
        try f.source.requireMicrophoneFinalization(runID: UUID().uuidString.lowercased())
      }
      f.source.retireForStop()
      try f.source.requireMicrophoneFinalization(runID: runID)
      f.source.retireForAuthenticationChange()
      try await rejects { try f.source.requireMicrophoneFinalization(runID: runID) }
      try await run.stop()
      try runRequire(f.journal.pending.isEmpty)
      try await rejects { try f.source.requireMicrophoneFinalization(runID: runID) }
      checks += 1
    }
    do {
      let f = try BoundSource()
      let run = try f.run(permission: { false })
      try await rejects { try await run.start() }
      let requests = await f.wire.requests
      try runRequire(!requests.contains { $0.action == .sourceStartReady })
      try runRequire(f.fixture.recorder.starts == 0 && run.phase == .stopped)
      checks += 2
    }
    return checks
  }
}

private final class RunRecords: NativeRecordingBindingRecordStore, NativeRecordingLeaseRecordStore,
  NativeRecordingRecordStore, @unchecked Sendable
{
  let lock = NSLock()
  var values: [String: NativeRecordingStoredRecord] = [:]
  func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
    lock.withLock { values[key] }
  }
  func readLease(key: String) throws -> NativeRecordingStoredRecord? { try readBinding(key: key) }
  func read(key: String) throws -> NativeRecordingStoredRecord {
    guard let value = try readBinding(key: key) else {
      throw NativeRecordingFailure.storageUnavailable
    }
    return value
  }
  func createBinding(key: String, data: Data) throws { try write(key, 0, data) }
  func createLease(key: String, data: Data) throws { try write(key, 0, data) }
  func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
    try write(key, expectedRevision, data)
  }
  func compareAndSwapLease(key: String, expectedRevision: UInt64, data: Data) throws {
    try write(key, expectedRevision, data)
  }
  func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
    try write(key, expectedRevision, data)
  }
  func availableBytes() throws -> Int { 2_000_000_000 }
  func write(_ key: String, _ revision: UInt64, _ data: Data) throws {
    try lock.withLock {
      guard values[key]?.revision ?? 0 == revision else {
        throw NativeRecordingBindingFailure.journalConflict
      }
      values[key] = NativeRecordingStoredRecord(data: data, revision: revision + 1)
    }
  }
  func captured() throws -> [Data] {
    try lock.withLock {
      try values.values.compactMap {
        let value = try JSONSerialization.jsonObject(with: $0.data) as! [String: Any]
        return value["state"] as? String == "encrypted" ? $0.data : nil
      }
    }
  }
}

private final class RunKeys: NativeRecordingKeyStorage, @unchecked Sendable {
  let lock = NSLock()
  var data: Data?
  func read(account: String) throws -> Data? { lock.withLock { data } }
  func insert(account: String, value: Data) throws {
    try lock.withLock {
      guard data == nil else { throw NativeRecordingFailure.keyConflict }
      data = value
    }
  }
}

private struct RunService: NativeRecordingLeaseService, NativeRecordingReservationService {
  let scope: NativeRecordingScope
  let lease: NativeRecordingLease
  func recordingScope() async throws -> NativeRecordingScope { scope }
  func requestLease(previous: NativeRecordingLease?, intent: UUID) async throws
    -> NativeRecordingLease
  {
    guard previous == nil else { throw ProviderNativeError.unavailable }
    return lease
  }
  func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) async throws
    -> NativeRecordingReservationBatch
  {
    let rows = try (first..<(first + count)).map { sequence in
      let object = UUID()
      return try NativeRecordingReservation(
        scope: scope, objectID: object, sequence: sequence,
        additionalData: nativeBase64URL(scope.additionalData(objectID: object, sequence: sequence)),
        createdAt: lease.issuedAt)
    }
    return NativeRecordingReservationBatch(
      batchID: UUID(), sessionID: scope.sessionID,
      authorizedUntil: lease.expiresAt, reservations: rows)
  }
}

private struct RunPermission: AppleMicrophonePermissionProviding {
  func currentPermission() -> AppleMicrophonePermissionState { .granted }
  func requestPermission() async -> AppleMicrophonePermissionState { .granted }
}
private struct RunForeground: AppleApplicationForegroundProviding {
  func isForegroundActive() async -> Bool { true }
}
private final class RunAudio: AppleAudioSystem, @unchecked Sendable {
  let lock = NSLock()
  var events: (@Sendable (AppleAudioSystemEvent) -> Void)?
  var frames: (@Sendable (OwnedAudioFrames) -> Void)?
  var selected: AppleAudioSessionProfile?
  var closures = 0
  func setEventHandler(_ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void) {
    lock.withLock { events = handler }
  }
  func clearEventHandler() { lock.withLock { events = nil } }
  func configureAndActivate(profile: AppleAudioSessionProfile) throws {
    lock.withLock { selected = profile }
  }
  func installInputTap(
    frameCapacity: UInt32, handler: @escaping @Sendable (OwnedAudioFrames) -> Void
  ) throws { lock.withLock { frames = handler } }
  func startEngine() throws {}
  func freezeInput() throws { lock.withLock { frames = nil } }
  func deactivate() throws { lock.withLock { closures += 1 } }
  func background() { lock.withLock { events }?(.backgrounded) }
  func emit(_ count: Int) throws -> OwnedAudioFrames {
    let value = OwnedAudioFrames(
      sampleRateHz: 16_000, channels: [Array(repeating: 0.125, count: count)])
    guard let accept = lock.withLock({ frames }) else { throw RunCheckFailure(line: #line) }
    accept(value)
    return value
  }
}

@MainActor private func checkActualEncryptedRun() async throws -> Int {
  let fixture = try Fixture()
  let driver = Driver()
  let wire = SourceWire(fixture.preparation)
  let policy = try NativeTokenPolicy(
    issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider")
  let auth = NativeWorkspaceAuth(
    enabled: true, organizationID: "org_offline", tokenPolicy: policy,
    driver: { driver }, accessBlock: { Block() })
  let connection = NativeProviderConnection(auth: auth, wire: wire)
  let journal = try NativeSourceProofJournal(platform: .ios, backing: JournalMemory())
  let source = try NativeSourceStartOwner(
    connection: connection, revision: auth.state().revision,
    preparation: fixture.preparation, identity: auth.state().identity!, journal: journal)
  let scope = try NativeRecordingScope(
    tenantID: UUID(), sessionID: fixture.lease.sessionID,
    workspaceID: fixture.preparation.workspaceID, accountDigest: String(repeating: "c", count: 64))
  guard
    let key = SecKeyCreateRandomKey(
      [
        kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072,
        kSecAttrIsPermanent: false,
      ] as CFDictionary, nil), let publicKey = SecKeyCopyPublicKey(key),
    let exported = SecKeyCopyExternalRepresentation(publicKey, nil)
  else { throw RunCheckFailure(line: #line) }
  let der = exported as Data
  let cipher = try NativeRecordingEncryption.create(
    scope: scope,
    published: NativeRecordingPublicKey(
      version: "synthetic-v1", modulusBase64URL: nativeBase64URL(der.subdata(in: 9..<393))),
    storage: RunKeys())
  let records = RunRecords()
  let service = RunService(scope: scope, lease: fixture.lease)
  let recovery = UUID()
  let leases = NativeRecordingLeaseOwner(scope: scope, service: service, records: records)
  let reservations = NativeRecordingReservationOwner(
    scope: scope, recoveryScope: recovery, service: service, records: records)
  let lease = try await leases.open()
  let batch = try await reservations.reserve(lease: lease, first: 0, count: 90)
  let system = RunAudio()
  let run = try NativeProviderRecordingRun(
    source: source, encryption: cipher, recoveryScope: recovery,
    records: records, priorPlaintextBytes: 0, lease: lease, batch: batch, leases: leases,
    reservations: reservations, permission: RunPermission(), system: system,
    foreground: RunForeground(), signal: PCMSignalMonitor())
  try runRequire(journal.pending.count == 1 && records.captured().isEmpty)
  try await run.start()
  try runRequire(run.phase == .recording && !run.isPhysicallyIdle)
  try runRequire(system.lock.withLock { system.selected == .nativeEncryptedSpeech })
  system.background()
  for _ in 0..<10 {
    let packet = try system.emit(16_000)
    try await CheckNativeRecordingRun.wait { packet.isZeroed }
    // Apple delivers this one-second buffer at real-time cadence. Do not
    // overrun the deliberately bounded callback with a zero-time test feeder.
    try await Task.sleep(for: .milliseconds(100))
  }
  try await CheckNativeRecordingRun.wait { run.captureState.committedChunks == 1 }
  let partial = try system.emit(8_000)
  try await CheckNativeRecordingRun.wait { partial.isZeroed }
  try await CheckNativeRecordingRun.wait { run.captureState.committedChunks == 1 }
  try runRequire(run.captureState.phase == .accepting)
  await wire.loseNextStop()
  try await CheckNativeRecordingRun.rejects { try await run.stop() }
  try runRequire(run.phase == .stopPending && run.isPhysicallyIdle && journal.pending.count == 1)
  print("synthetic PCM custody: \(run.captureState)")
  try runRequire(
    run.captureState.committedChunks == 2 && run.captureState.committedPlaintextBytes == 336_088)
  let captured = try records.captured()
  try runRequire(captured.count == 2 && system.lock.withLock { system.closures } == 1)
  try await run.stop()
  try runRequire(run.phase == .stopped && journal.pending.isEmpty)
  try runRequire(Set(try records.captured()) == Set(captured))  // No re-encryption on stop retry.
  try runRequire(system.lock.withLock { system.closures } == 1)
  try await NativeCaptureStartGate.recoverWhileIdle {}
  return 10
}
