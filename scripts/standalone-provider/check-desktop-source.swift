import Foundation
import CosmasNativeAuth

// Actual desktop source/registry/journal with only synthetic SDK, wire and storage.
// No microphone, network, account or Keychain is accessed.
@MainActor private final class JournalMemory: NativeSourceJournalBacking {
  var data: Data?
  var fail = false
  var onNextRead: (() -> Void)?
  func read() throws -> Data? {
    let hook = onNextRead; onNextRead = nil; hook?()
    return data
  }
  func write(_ value: Data) throws {
    if fail { throw NativeSourceJournalError.unavailable }
    data = value
  }
}

private actor SourceWire: ProviderNativeWire {
  let preparation: NativeSourcePreparation
  let responseDate = Date()
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
      case "authorize-capability": receipt["capability_id"] = UUID().uuidString.lowercased()
      case "authorize-preparation-expiry": receipt["preparation_expires_at"] = "2099-01-01T00:00:00Z"
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
    return ProviderNativeReply(status: 200,
      body: try JSONSerialization.data(withJSONObject: response(action: action, body: body)))
  }
  private func response(action: String, body: [String: Any]) -> [String: Any] {
    let operation = body["operation"] as! [String: Any]
    let payload = operation["payload"] as! [String: Any]
    let now = responseDate
    let format = ISO8601DateFormatter()
    let expires = format.string(
      from: min(
        now.addingTimeInterval(10),
        format.date(from: preparation.captureAuthorizedUntil)!))
    var receipt: [String: Any] = [
      "schema_version": "1.0", "session_id": preparation.sessionID.uuidString.lowercased(),
      "attempt_id": payload["attempt_id"]!, "source_start_id": sourceID,
      "creator_actor_id": "synthetic-provider", "consent_record_id": consentID,
      "source": preparation.source.rawValue, "lease_id": preparation.leaseID.uuidString.lowercased(),
      "lease_receipt_id": preparation.leaseReceiptID.uuidString.lowercased(),
      "lease_generation": preparation.leaseGeneration,
      "state": action == "prepare" ? "prepared" : (action == "stop" ? "stopped" : "issued"),
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

@MainActor private final class Clock { var value = Date() }
@MainActor private struct Fixture {
  let preparation: NativeSourcePreparation
  let driver = Driver(), memory = JournalMemory(), clock = Clock()
  let registry = DesktopSourceRegistry(), id = UUID()
  let journal: NativeSourceProofJournal
  let auth: NativeWorkspaceAuth
  let connection: NativeProviderConnection
  let wire: SourceWire
  init(first: Int = 0) throws {
    preparation = try NativeSourcePreparation(workspaceID: UUID(),
      bindingRef: "scribe_capture_binding_01j00000000000000000000000", sessionID: UUID(),
      leaseID: UUID(), leaseReceiptID: UUID(), leaseGeneration: 1,
      captureAuthorizedUntil: ISO8601DateFormatter().string(from: Date().addingTimeInterval(900)),
      source: .desktop, firstSequenceNumber: first)
    journal = try NativeSourceProofJournal(platform: .desktop, backing: memory)
    try journal.initializeAnchor(NativeFenceAnchor(
      coordinator: NativeFenceFileIdentity(device: 1, inode: 2),
      capture: NativeFenceFileIdentity(device: 1, inode: 3)))
    wire = SourceWire(preparation)
    let driver = driver
    auth = NativeWorkspaceAuth(enabled: true, organizationID: "org_offline",
      tokenPolicy: try NativeTokenPolicy(issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider"),
      driver: { driver }, accessBlock: { Block() })
    connection = NativeProviderConnection(auth: auth, wire: wire, requestTiming: { _ in })
    let connection = connection
    auth.onChange = { [weak connection] state in connection?.authChanged(state) }
  }
  func prepare(combined: Bool = true) async throws -> NativeSourceGrant {
    try await registry.prepare(id: id, preparation: preparation, forStart: combined) {
      try NativeSourceStartOwner(connection: connection, revision: auth.state().revision,
        preparation: preparation, identity: auth.state().identity!, journal: journal,
        now: { clock.value })
    }
  }
}

@main private struct CheckDesktopSource {
  @MainActor static func rejects(_ operation: () async throws -> Void) async throws {
    do { try await operation() } catch { return }
    throw CheckFailure.failed
  }
  @MainActor static func main() async throws {
    var checks = 0
    // Real filesystem locks, generated private files and in-memory journals.
    // Change only the saved mount number to reproduce the reboot failure.
    #if os(macOS)
    let directory = URL(fileURLWithPath: "/private/tmp", isDirectory: true).appendingPathComponent("scribe-fence-check-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    var original: NativeCaptureProcessCoordinator? = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: nil)
    let mounted = original!.anchor
    let changedDevice = mounted.coordinator.device + 2
    let legacy = NativeFenceAnchor(coordinator: .init(device: changedDevice, inode: mounted.coordinator.inode),
      capture: .init(device: changedDevice, inode: mounted.capture.inode))
    let remounted = NativeFenceAnchor(coordinator: legacy.coordinator, capture: legacy.capture, volumeID: mounted.volumeID)
    try require(mounted.volumeID != nil && mounted.matchesMountedFiles(remounted, allowLegacyRemount: false))
    let ticket = try NativeFenceTicket(original!.wireValue)
    try require(ticket.anchor.coordinator == mounted.coordinator && ticket.anchor.capture == mounted.capture)
    try await rejects { _ = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: mounted) }
    original = nil
    try await rejects { _ = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: legacy) }
    try await rejects { _ = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: nil) }
    checks += 1
    do {
      let memory = JournalMemory()
      memory.data = try JSONSerialization.data(withJSONObject: ["schema": 1, "platform": "desktop", "owners": [],
        "anchor": ["coordinator": ["device": changedDevice, "inode": mounted.coordinator.inode],
                   "capture": ["device": changedDevice, "inode": mounted.capture.inode]]])
      let journal = try NativeSourceProofJournal(platform: .desktop, backing: memory)
      let recovered = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: journal.anchor,
        allowLegacyRemount: journal.pending.isEmpty)
      try journal.reloadWhileExclusive(expectedAnchor: legacy)
      try journal.initializeAnchor(recovered.anchor)
      let reread = try NativeSourceProofJournal(platform: .desktop, backing: memory)
      try require(reread.anchor == mounted && reread.pending.isEmpty)
      try recovered.allowCaptureAfterConfirmedRecovery()
      let lease = try NativeCaptureProcessLease(privateDirectory: directory.path,
        expectedAnchor: NativeFenceTicket(recovered.wireValue).anchor, expectedEpoch: recovered.epoch)
      try await rejects { _ = try NativeCaptureProcessLease(privateDirectory: directory.path,
        expectedAnchor: mounted, expectedEpoch: UUID().uuidString.lowercased()) }
      withExtendedLifetime(lease) {}
      checks += 1
    }
    do {
      let recovered = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: remounted)
      try require(recovered.anchor == mounted)
      let memory = JournalMemory(); let journal = try NativeSourceProofJournal(platform: .desktop, backing: memory)
      try journal.initializeAnchor(remounted)
      try journal.initializeAnchor(recovered.anchor)
      try require(journal.anchor == mounted)
      checks += 1
    }
    let wrongVolume = NativeFenceAnchor(coordinator: mounted.coordinator, capture: mounted.capture,
      volumeID: UUID().uuidString.lowercased())
    try await rejects { _ = try NativeCaptureProcessCoordinator(privateDirectory: directory.path,
      expectedAnchor: wrongVolume, allowLegacyRemount: true) }
    do {
      let memory = JournalMemory(); let journal = try NativeSourceProofJournal(platform: .desktop, backing: memory)
      try journal.initializeAnchor(wrongVolume)
      try await rejects { try journal.initializeAnchor(mounted) }
      try require(journal.anchor == wrongVolume)
      checks += 1
    }
    do {
      let f = try Fixture(); _ = try await f.prepare()
      try await rejects { try f.journal.initializeAnchor(mounted) }
      try require(f.journal.pending.count == 1 && f.journal.anchor?.volumeID == nil)
      checks += 1
    }
    for changedMount in [true, false] {
      let f = try Fixture(); _ = try await f.prepare()
      var envelope = try JSONSerialization.jsonObject(with: f.memory.data!) as! [String: Any]
      let saved = changedMount ? legacy : NativeFenceAnchor(coordinator: mounted.coordinator, capture: mounted.capture)
      envelope["anchor"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(saved))
      f.memory.data = try JSONSerialization.data(withJSONObject: envelope)
      let journal = try NativeSourceProofJournal(platform: .desktop, backing: f.memory)
      let recovery = NativeSourceRecovery(journal: journal, desktopDirectory: directory.path)
      let before = await f.wire.requests.count
      if changedMount {
        try await rejects { try await recovery.recover(connection: f.connection) }
        try require(journal.pending.count == 1 && journal.anchor == legacy)
        try require(await f.wire.requests.count == before)
      } else {
        try await recovery.recover(connection: f.connection)
        try recovery.requireReady()
        try require(journal.pending.isEmpty && journal.anchor == mounted)
        try require(await f.wire.stopAttempts.count == 1)
      }
      checks += 1
    }
    do {
      let f = try Fixture(); _ = try await f.prepare()
      var pendingEnvelope = try JSONSerialization.jsonObject(with: f.memory.data!) as! [String: Any]
      pendingEnvelope["anchor"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy))
      let pendingBytes = try JSONSerialization.data(withJSONObject: pendingEnvelope)
      var emptyEnvelope = pendingEnvelope; emptyEnvelope["owners"] = []
      f.memory.data = try JSONSerialization.data(withJSONObject: emptyEnvelope)
      let journal = try NativeSourceProofJournal(platform: .desktop, backing: f.memory)
      f.memory.onNextRead = { f.memory.data = pendingBytes }
      let recovery = NativeSourceRecovery(journal: journal, desktopDirectory: directory.path)
      let before = await f.wire.requests.count
      try await rejects { try await recovery.recover(connection: f.connection) }
      try require(journal.pending.count == 1 && journal.anchor == legacy)
      try require(await f.wire.requests.count == before)
      checks += 1
    }
    do {
      let memory = JournalMemory(); let journal = try NativeSourceProofJournal(platform: .desktop, backing: memory)
      try journal.initializeAnchor(legacy)
      memory.fail = true
      try await rejects { try journal.initializeAnchor(mounted) }
      try await rejects { try journal.requireUsable() }
      try require(journal.anchor == legacy)
      memory.fail = false
      try journal.reloadWhileExclusive(expectedAnchor: legacy)
      try journal.initializeAnchor(mounted)
      try journal.requireUsable()
      checks += 1
    }
    var active: NativeCaptureProcessLease?
    do {
      var current: NativeCaptureProcessCoordinator? = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: mounted)
      try current!.allowCaptureAfterConfirmedRecovery()
      // Keep only the capture lease alive; a replacement coordinator must
      // still fail while the original audio process owns its shared lock.
      active = try NativeCaptureProcessLease(privateDirectory: directory.path,
        expectedAnchor: mounted, expectedEpoch: current!.epoch)
      current = nil
    }
    try await rejects { _ = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: remounted) }
    withExtendedLifetime(active) {}
    active = nil
    checks += 1
    let capturePath = directory.appendingPathComponent("capture.lock")
    try FileManager.default.moveItem(at: capturePath, to: directory.appendingPathComponent("prior-capture.lock"))
    _ = FileManager.default.createFile(atPath: capturePath.path, contents: Data(), attributes: [.posixPermissions: 0o600])
    try await rejects { _ = try NativeCaptureProcessCoordinator(privateDirectory: directory.path,
      expectedAnchor: mounted, allowLegacyRemount: true) }
    checks += 1
    try FileManager.default.removeItem(at: capturePath)
    try FileManager.default.createSymbolicLink(at: capturePath, withDestinationURL: directory.appendingPathComponent("prior-capture.lock"))
    try await rejects { _ = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: mounted) }
    checks += 1
    try FileManager.default.removeItem(at: capturePath)
    try FileManager.default.moveItem(at: directory.appendingPathComponent("prior-capture.lock"), to: capturePath)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: capturePath.path)
    try await rejects { _ = try NativeCaptureProcessCoordinator(privateDirectory: directory.path, expectedAnchor: mounted) }
    checks += 1
    #endif
    for first in [0, 1024] {
      let f = try Fixture(first: first)
      let grant = try await f.prepare()
      let before = await f.wire.requests
      try require(before.count == 1 && before[0].action == .sourceStartReady)
      let body = try JSONSerialization.jsonObject(with: before[0].body) as! [String: Any]
      try require(body["authorize_idempotency_key"] as? String != before[0].key)
      try require(body["authorize_request_nonce"] as? String != body["request_nonce"] as? String)
      try require(grant.desktopPayload["captureCapability"] == nil)
      let decision = try await f.registry.authorize(sourceLeaseID: grant.sourceLeaseID)
      try require(decision.grant.sourceLeaseID == grant.sourceLeaseID && decision.secret.count == 64)
      try require(await f.wire.requests.count == 1)
      try await rejects { _ = try await f.registry.authorize(sourceLeaseID: grant.sourceLeaseID) }
      try require(await f.wire.requests.count == 1)
      try await rejects { try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: false) }
      try require(f.journal.pending.count == 1)
      try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: true)
      try require(f.journal.pending.isEmpty)
      checks += 1
    }
    for combined in [false, true] {
      let f = try Fixture()
      if combined { await f.wire.configure(status: 404) }
      let grant = try await f.prepare(combined: combined)
      _ = try await f.registry.authorize(sourceLeaseID: grant.sourceLeaseID)
      let calls = await f.wire.requests
      try require(calls.count == (combined ? 3 : 2))
      try require(calls.suffix(2).allSatisfy { $0.action == .sourceStart })
      try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: true)
      checks += 1
    }
    let faults = ["lost", "prepare-nonce", "authorize-nonce", "prepare-state", "prepare-session",
      "prepare-expired", "authorize-secret", "authorize-source", "authorize-consent", "authorize-expired",
      "authorize-position", "authorize-capability", "authorize-preparation-expiry"]
    for fault in faults + ["401", "403", "409", "422", "503"] {
      let f = try Fixture(first: 1024)
      await f.wire.configure(status: Int(fault) ?? 200, fault: fault)
      try await rejects { _ = try await f.prepare() }
      try require(await f.wire.requests.count == 1)
      try require(f.journal.pending.count == 1)
      let original = f.journal.pending[0]
      try await rejects { _ = try await f.prepare() }
      try require(await f.wire.requests.count == 1)
      try await f.registry.releasePreparation(id: f.id)
      try require(f.journal.pending.isEmpty)
      let stop = await f.wire.stopAttempts
      try require(stop.count == 1 && stop[0].0 == original.stopKey.uuidString.lowercased())
      let stopped = try JSONSerialization.jsonObject(with: stop[0].1) as! [String: Any]
      try require(stopped["owner_proof"] as? String == original.ownerProof)
      checks += 1
    }
    do {
      let f = try Fixture(); f.memory.fail = true
      try await rejects { _ = try await f.prepare() }
      try require(await f.wire.requests.isEmpty)
      checks += 1
    }
    do {
      let f = try Fixture(); let grant = try await f.prepare()
      await f.wire.loseNextStop()
      try await rejects { try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: false) }
      try require(f.journal.pending.count == 1)
      try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: false)
      let stops = await f.wire.stopAttempts
      try require(stops.count == 2 && stops[0].0 == stops[1].0 && stops[0].1 == stops[1].1)
      try require(f.journal.pending.isEmpty)
      checks += 1
    }
    do {
      let f = try Fixture(); let grant = try await f.prepare()
      f.clock.value = f.clock.value.addingTimeInterval(30)
      try await rejects { _ = try await f.registry.authorize(sourceLeaseID: grant.sourceLeaseID) }
      try require(await f.wire.requests.count == 1)
      try await rejects { try await f.registry.releasePreparation(id: f.id) }
      try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: true)
      checks += 1
    }
    do {
      let f = try Fixture(); let grant = try await f.prepare()
      f.driver.identity = try NativeAuthIdentity(userID: "user_offline", sessionID: "sess_changed", organizationID: "org_offline")
      _ = f.auth.state()
      try await rejects { _ = try await f.registry.authorize(sourceLeaseID: grant.sourceLeaseID) }
      try require(await f.wire.requests.count == 1)
      try require(f.journal.pending.count == 1)
      // Restore a synthetic SDK session matching Driver.token's fixed claims
      // before testing same-account cessation under a new auth revision.
      f.driver.identity = try NativeAuthIdentity(userID: "user_offline", sessionID: "sess_offline", organizationID: "org_offline")
      _ = f.auth.state()
      try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: true)
      checks += 1
    }
    do {
      let f = try Fixture(); await f.wire.configure(hold: true)
      let pending = Task { @MainActor in try await f.prepare() }
      await f.wire.waitUntilHeld()
      try await rejects { try await f.registry.releasePreparation(id: f.id) }
      await f.wire.release()
      try await rejects { _ = try await pending.value }
      try require(f.journal.pending.count == 1)
      try await f.registry.releasePreparation(id: f.id)
      try require(f.journal.pending.isEmpty)
      checks += 1
    }
    do {
      let f = try Fixture(); await f.wire.configure(hold: true)
      let pending = Task { @MainActor in try await f.prepare() }
      await f.wire.waitUntilHeld(); pending.cancel(); await f.wire.release()
      try await rejects { _ = try await pending.value }
      try require(await f.wire.requests.count == 1)
      try await f.registry.releasePreparation(id: f.id)
      checks += 1
    }
    do {
      let f = try Fixture(); let grant = try await f.prepare()
      f.registry.retireForAuthenticationChange()
      try await rejects { _ = try await f.registry.authorize(sourceLeaseID: grant.sourceLeaseID) }
      try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: false)
      try require(f.journal.pending.isEmpty)
      checks += 1
    }
    do {
      let f = try Fixture(); let grant = try await f.prepare(combined: false)
      try await rejects { _ = try await f.prepare(combined: true) }
      try require(await f.wire.requests.count == 1)
      try await f.registry.release(sourceLeaseID: grant.sourceLeaseID, stopped: false)
      checks += 1
    }
    do {
      let f = try Fixture(); _ = try await f.prepare()
      let restarted = try NativeSourceProofJournal(platform: .desktop, backing: f.memory)
      try require(restarted.pending.count == 1)
      let record = restarted.pending[0]
      _ = try await record.stop(connection: f.connection)
      try restarted.removeAfterConfirmedStop(record)
      try require(restarted.pending.isEmpty)
      checks += 1
    }
    print("Desktop source checks: \(checks) passed; synthetic wire/SDK/storage, no microphone or network.")
  }
}
