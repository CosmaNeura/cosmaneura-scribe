import CosmaneuraIOSAVFoundationDriver
import CosmasNativeAuth
import Foundation
import Security

@testable import CosmaneuraIOSPCMCore
@testable import CosmaneuraNativeRecording
@testable import CosmaneuraNativeRecordingPCM

// Synthetic consent fixtures only: in-memory custody, generated PCM and ephemeral
// test wrapping keys. No OS source, account, Keychain or service is accessed.
@MainActor enum CheckNativeRecordingHost {
  private struct Failed: Error { let line: UInt }
  private static func check(_ value: Bool, line: UInt = #line) throws {
    if !value { throw Failed(line: line) }
  }
  private static func rejects(_ body: () async throws -> Void, line: UInt = #line) async throws {
    do { try await body() } catch { return }
    throw Failed(line: line)
  }
  private static func wait(_ body: () async -> Bool) async throws {
    for _ in 0..<1000 {
      if await body() { return }
      try await Task.sleep(for: .milliseconds(1))
    }
    throw Failed(line: #line)
  }
  private final class PassageGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var started = false, released = false
    var running: Bool { condition.lock();defer { condition.unlock() };return started }
    func hold() throws {
      condition.lock();defer { condition.unlock() };started = true
      let deadline = Date().addingTimeInterval(5)
      while !released { guard condition.wait(until: deadline) else { throw CancellationError() } }
    }
    func release() { condition.lock();released = true;condition.broadcast();condition.unlock() }
  }
  private final class Records: NativeProviderRecordingHost.Records, @unchecked Sendable {
    var rows: [String: NativeRecordingStoredRecord] = [:]
    var failSeal = false, failInventory = false, loseSealReply = false
    var failCheckpoint = false, failPassage = false
    var passageGate: PassageGate?
    func read(key: String) throws -> NativeRecordingStoredRecord {
      guard let row = rows[key] else { throw NativeRecordingFailure.storageUnavailable }
      return row
    }
    func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
      if loseSealReply, let row = rows[key],
        let value = try JSONSerialization.jsonObject(with: row.data) as? [String: Any],
        value["completionLease"] != nil
      {
        throw NativeRecordingFailure.storageUnavailable
      }
      return rows[key]
    }
    func readLease(key: String) -> NativeRecordingStoredRecord? { rows[key] }
    func availableBytes() -> Int { 2_000_000_000 }
    func listRecordingKeys(prefix: String) throws -> [String] {
      if failInventory { throw NativeRecordingFailure.storageUnavailable }
      return rows.keys.filter { $0.hasPrefix(prefix) }
    }
    func createBinding(key: String, data: Data) throws {
      if key.hasPrefix("scribe-native-passage:") { try passageGate?.hold() }
      if failPassage && key.hasPrefix("scribe-native-passage:") { throw NativeRecordingFailure.storageUnavailable }
      try compareAndSwap(key: key, expectedRevision: 0, data: data)
    }
    func createLease(key: String, data: Data) throws { try createBinding(key: key, data: data) }
    func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      let sealing = value?["completionLease"] != nil
      if failCheckpoint && value?["sourceCheckpoint"] != nil {
        throw NativeRecordingFailure.storageUnavailable
      }
      if failSeal && sealing { throw NativeRecordingFailure.storageUnavailable }
      try compareAndSwap(key: key, expectedRevision: expectedRevision, data: data)
      if loseSealReply && sealing { throw NativeRecordingFailure.storageUnavailable }
    }
    func compareAndSwapLease(key: String, expectedRevision: UInt64, data: Data) throws {
      try compareAndSwap(key: key, expectedRevision: expectedRevision, data: data)
    }
    func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      guard rows[key]?.revision ?? 0 == expectedRevision else {
        throw NativeRecordingBindingFailure.journalConflict
      }
      rows[key] = NativeRecordingStoredRecord(data: data, revision: expectedRevision + 1)
    }
  }
  private final class Keys: NativeRecordingKeyStorage, @unchecked Sendable {
    var value: Data?
    func read(account: String) -> Data? { value }
    func insert(account: String, value: Data) throws {
      guard self.value == nil else { throw NativeRecordingFailure.keyConflict }
      self.value = value
    }
  }
  private actor Service: NativeProviderRecordingHost.Service {
    let scope: NativeRecordingScope, published: NativeRecordingPublicKey
    let leaseID = UUID()
    var objects: [Int: NativeRecordingReservation] = [:]
    var bindings = 0, issues = 0, renewals = 0, reservations = 0
    var reservationSizes: [Int] = []
    var leaseIntents: [UUID] = []
    var leaseReceipts: [UUID: NativeRecordingLease] = [:]
    var loseLeaseReply = false
    var now: Date?
    var failAll = false, hold = false, expired = false
    var pending: CheckedContinuation<Void, Never>?
    init(scope: NativeRecordingScope, published: NativeRecordingPublicKey) {
      self.scope = scope
      self.published = published
    }
    func configure(
      hold: Bool = false, expired: Bool = false, failAll: Bool = false,
      loseLeaseReply: Bool = false, now: Date? = nil
    ) {
      self.hold = hold
      self.expired = expired
      self.failAll = failAll
      self.loseLeaseReply = loseLeaseReply
      self.now = now
    }
    func release() {
      hold = false
      pending?.resume()
      pending = nil
    }
    func recordingScope() throws -> NativeRecordingScope {
      if failAll { throw NativeRecordingBindingFailure.authorityChanged }
      return scope
    }
    func publishedKey() throws -> NativeRecordingPublicKey {
      _ = try recordingScope()
      return published
    }
    func bind(key: NativeRecordingKeyReceipt, intent: UUID) throws
      -> NativeRecordingBindingAcknowledgement
    {
      _ = try recordingScope()
      bindings += 1
      return NativeRecordingBindingAcknowledgement(
        sessionID: scope.sessionID, keyVersion: key.keyVersion)
    }
    func requestLease(previous: NativeRecordingLease?, intent: UUID) async throws
      -> NativeRecordingLease
    {
      leaseIntents.append(intent)
      if hold { await withCheckedContinuation { pending = $0 } }
      _ = try recordingScope()
      if let receipt = leaseReceipts[intent] { return receipt }
      if previous == nil { issues += 1 } else { renewals += 1 }
      let issued = (now ?? Date()).addingTimeInterval(previous == nil && expired ? -1800 : -2)
      let receipt = try NativeRecordingLease(
        receiptID: UUID(), leaseID: leaseID, sessionID: scope.sessionID,
        generation: (previous?.generation ?? 0) + 1,
        issuedAt: ISO8601DateFormatter().string(from: issued),
        expiresAt: ISO8601DateFormatter().string(from: issued.addingTimeInterval(900)))
      leaseReceipts[intent] = receipt
      if loseLeaseReply {
        loseLeaseReply = false
        throw Failed(line: #line)
      }
      return receipt
    }
    func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) throws
      -> NativeRecordingReservationBatch
    {
      _ = try recordingScope()
      reservations += 1
      reservationSizes.append(count)
      let rows = try (first..<(first + count)).map { sequence in
        if let row = objects[sequence] { return row }
        let object = UUID()
        let row = try NativeRecordingReservation(
          scope: scope, objectID: object, sequence: sequence,
          additionalData: nativeBase64URL(
            scope.additionalData(objectID: object, sequence: sequence)), createdAt: lease.issuedAt)
        objects[sequence] = row
        return row
      }
      return NativeRecordingReservationBatch(
        batchID: UUID(), sessionID: scope.sessionID,
        authorizedUntil: lease.expiresAt, reservations: rows)
    }
  }
  private final class Source: NativeProviderMicrophoneSource {
    let recordingPreparation: NativeSourcePreparation
    var stops = 0, failStop = false, confirmed = false
    init(_ value: NativeSourcePreparation) { recordingPreparation = value }
    func prepare() throws -> NativeSourceGrant { throw Failed(line: #line) }
    func consumeForMicrophone() throws -> NativeCapturePermit { throw Failed(line: #line) }
    func requireActiveMicrophone(runID: String) throws { throw Failed(line: #line) }
    func requireMicrophoneFinalization(runID: String) throws { throw Failed(line: #line) }
    func retireForStop() {}
    func retireForAuthenticationChange() {}
    func confirmStopped() throws {
      if confirmed { throw Failed(line: #line) }
      stops += 1
      if failStop { throw Failed(line: #line) }
      confirmed = true
    }
  }
  private final class Interval: NativeProviderRecordingInterval {
    let sink: NativeRecordingPCMSink
    let source: Source
    let first: Int, prior: Int
    var phase: NativeProviderRecordingRun.Phase = .ready
    var isPhysicallyIdle = true, failStop = false, empty = false, committed = false
    var incomplete = false
    var stopCalls = 0
    let meter = PCMSignalMonitor()
    init(
      source: Source, cipher: NativeRecordingEncryption, recovery: UUID, records: Records,
      prior: Int, batch: NativeRecordingReservationBatch
    ) throws {
      self.source = source
      self.prior = prior
      first = batch.reservations[0].sequence
      sink = try NativeRecordingPCMSink(
        encryption: cipher, recoveryScope: recovery, records: records,
        firstSequence: first, priorPlaintextBytes: prior,
        maximumPlaintextBytes: NativeRecordingFlowOwner.maximumPlaintextBytes)
      try sink.stage(batch)
    }
    var captureState: NativeRecordingPCMState { sink.state }
    var capturedAudioFrames = 0
    func emit(_ byteCount: Int = 160) throws {
      let pcm = OwnedPCMBytes([UInt8](repeating: 4, count: byteCount))
      _ = try sink.emit(
        PCMEncodedPacket(
          sequenceNumber: UInt64(sink.state.committedChunks), bytes: pcm))
      capturedAudioFrames += byteCount / 2
      try check(pcm.withUnsafeBytes { $0.allSatisfy { $0 == 0 } })
      committed = true
    }
    func captureSignal() -> PCMSignalMonitor.Snapshot { meter.snapshot() }
    func start() {
      phase = .recording
      isPhysicallyIdle = false
    }
    func stop() throws {
      stopCalls += 1
      if incomplete {
        isPhysicallyIdle = true
        phase = .stopped
        throw NativeRecordingFinalizationFailure.storageFailed
      }
      if phase == .stopped { return }
      isPhysicallyIdle = true
      if !committed && !empty {
        try emit()
      }
      if sink.state.phase != .closed {
        try sink.finish(PCMStopResult(finalPacket: nil))
      }
      if failStop {
        phase = .stopPending
        throw Failed(line: #line)
      }
      try source.confirmStopped()
      phase = .stopped
    }
    func retire() { phase = .stopPending }
  }
  @MainActor private final class Fixture {
    let scope: NativeRecordingScope, recovery = UUID(), records = Records(), keys = Keys()
    let service: Service
    var sources: [Source] = [], runs: [Interval] = [], failFactory = false, deny = false
    var failSourceStop = false
    init() throws {
      scope = try NativeRecordingScope(
        tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
        accountDigest: String(repeating: "a", count: 64))
      guard
        let key = SecKeyCreateRandomKey(
          [
            kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072,
            kSecAttrIsPermanent: false,
          ] as CFDictionary, nil), let pub = SecKeyCopyPublicKey(key),
        let data = SecKeyCopyExternalRepresentation(pub, nil) as Data?
      else { throw Failed(line: #line) }
      service = Service(
        scope: scope,
        published: try NativeRecordingPublicKey(
          version: "synthetic-v1",
          modulusBase64URL: nativeBase64URL(data.subdata(in: 9..<393))))
    }
    func host(
      service override: (any NativeProviderRecordingHost.Service)? = nil,
      now: @escaping @MainActor () -> Date = { Date() }
    ) -> NativeProviderRecordingHost {
      NativeProviderRecordingHost(
        scope: scope, recoveryScope: recovery, service: override ?? service, records: records,
        keys: keys,
        requireCurrent: { if self.deny { throw NativeRecordingBindingFailure.authorityChanged } },
        recoverSources: {},
        makeSource: { lease, batch in
          let source = Source(
            try NativeSourcePreparation(
              workspaceID: self.scope.workspaceID,
              bindingRef: "scribe_capture_binding_01j00000000000000000000000",
              sessionID: self.scope.sessionID,
              leaseID: lease.leaseID, leaseReceiptID: lease.receiptID,
              leaseGeneration: lease.generation,
              captureAuthorizedUntil: lease.expiresAt, source: .ios,
              firstSequenceNumber: batch.reservations[0].sequence))
          source.failStop = self.failSourceStop
          self.sources.append(source)
          return source
        },
        makeRun: { source, cipher, prior, _, batch, _, _, _ in
          if self.failFactory { throw Failed(line: #line) }
          let run = try Interval(
            source: source as! Source, cipher: cipher, recovery: self.recovery,
            records: self.records, prior: prior, batch: batch)
          self.runs.append(run)
          return run
        }, now: now)
    }
  }

  static func run() async throws -> Int {
    var checks = 0
    do {
      let f = try Fixture(), host = f.host(), gate = PassageGate()
      try await host.open();try await host.start();f.records.passageGate = gate
      let sealing = Task { try await host.sealForUpload() }
      try await wait { gate.running }
      try check(host.busy && f.runs[0].isPhysicallyIdle)
      let closing = Task { try await host.close() }
      try await wait { host.requiresReopen }
      let other = f.host();try await rejects { try await other.open() };try await other.close()
      gate.release()
      try await rejects { try await sealing.value };try await closing.value
      try check(host.phase == .closed && !f.records.rows.keys.contains { $0.hasSuffix(":manifest") })
      let reopened = f.host();try await reopened.open();try await reopened.close();checks += 3
    }
    do {
      let f = try Fixture(), host = f.host()
      try await host.open();try await host.start()
      f.records.failPassage = true
      try await rejects { try await host.sealForUpload() }
      try check(host.saved?.phase == .sealed && f.runs[0].isPhysicallyIdle)
      try check(f.records.rows.keys.contains { $0.hasPrefix("scribe-provider-queue:") })
      try await host.close();f.records.failPassage = false
      let reopened = f.host();try await reopened.open();try await reopened.sealForUpload()
      let archive = try NativeRecordingPassageArchive.open(account: f.scope.accountDigest, recovery: f.recovery,
        workspace: f.scope.workspaceID, session: f.scope.sessionID, records: f.records)
      try check(archive != nil)
      // Match CaptureQueue.purge: retain reservation/registration metadata,
      // remove only ciphertext fields. This is not a queue-delete operation.
      for (key, stored) in f.records.rows where key.hasPrefix("scribe-provider-queue:") {
        var value = try JSONSerialization.jsonObject(with: stored.data) as! [String: Any]
        guard value["state"] as? String == "encrypted" else { continue }
        value["state"] = "purged"
        for field in ["envelope", "sha256", "byteLength"] { value.removeValue(forKey: field) }
        f.records.rows[key] = NativeRecordingStoredRecord(data: try JSONSerialization.data(withJSONObject: value), revision: stored.revision + 1)
      }
      let audio = try archive?.audio(startMs: 0, endMs: 5, keys: f.keys, current: {})
      try check(audio?.count == 204)
      try await reopened.sealForUpload() // Retained archive survives idempotent post-purge seal.
      try await reopened.close();checks += 3
    }
    do {
      let f = try Fixture()
      let host = f.host()
      await f.service.configure(hold: true)
      try await host.open()
      try await wait { await f.service.pending != nil }
      let key = f.keys.value
      let intent = host.saved!.completionIntent
      var settled = false
      let start = Task {
        defer { settled = true }
        do {
          try await host.start()
          return true
        } catch { return false }
      }
      try await wait { host.phase == .starting }
      try await host.pause()
      // The held service deliberately ignores cancellation. Cancel must settle
      // the visible Start while the original preparation remains in custody.
      try await wait { settled && !host.busy }
      try check(await start.value == false)
      try check(host.phase == .paused && host.failure == nil)
      try check(await f.service.pending != nil)
      try check(f.sources.isEmpty && f.runs.isEmpty)
      // Retrying waits behind the same retained request, never overlaps it or
      // changes its idempotency key. Late completion cannot start the old run.
      let retry = Task { try await host.start() }
      try await wait { host.phase == .starting }
      try check(await f.service.leaseIntents.count == 1)
      try check(f.sources.isEmpty && f.runs.isEmpty)
      await f.service.release()
      try await retry.value
      let intents = await f.service.leaseIntents
      try check(intents.count == 2 && Set(intents).count == 1)
      try check(await f.service.issues == 1)
      try check(host.phase == .recording && f.runs.count == 1)
      try check(f.keys.value == key && host.saved!.completionIntent == intent)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      await f.service.configure(hold: true)
      try await host.open()
      try await wait { await f.service.pending != nil }
      try check(host.phase == .ready && !host.busy && f.sources.isEmpty && f.runs.isEmpty)
      let key = f.keys.value
      let start = Task { try await host.start() }
      await Task.yield()
      try check(f.sources.isEmpty && f.runs.isEmpty)
      await f.service.release()
      try await start.value
      try check(await f.service.leaseIntents.count == 1)
      try check(await f.service.reservationSizes == [30])
      try check(host.phase == .recording && f.runs.count == 1 && f.keys.value == key)
      try await host.pause()
      try await host.start()
      try check(await f.service.leaseIntents.count == 1)
      try check(await f.service.reservationSizes == [30])
      try check(f.runs.count == 2 && f.runs[1].first == 1 && f.keys.value == key)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      await f.service.configure(loseLeaseReply: true)
      try await host.open()
      try await wait { await f.service.leaseIntents.count == 1 }
      for _ in 0..<10 { await Task.yield() }
      try check(await f.service.leaseIntents.count == 1)
      try check(host.phase == .ready && host.failure == nil && f.sources.isEmpty)
      try await host.start()
      let intents = await f.service.leaseIntents
      try check(intents.count == 2 && Set(intents).count == 1)
      try check(await f.service.issues == 1)
      try check(await f.service.reservationSizes == [30])
      try check(host.phase == .recording && f.runs.count == 1)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      var now = Date()
      let host = f.host(now: { now })
      await f.service.configure(now: now)
      try await host.open()
      try await wait { await f.service.reservations == 1 }
      try check(host.phase == .ready && f.sources.isEmpty)
      now = now.addingTimeInterval(901)
      await f.service.configure(now: now)
      try await host.start()
      try check(await f.service.renewals == 1)
      try check(await f.service.reservationSizes == [30, 30])
      try check(f.sources[0].recordingPreparation.leaseGeneration == 2)
      try check(host.phase == .recording)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      await f.service.configure(hold: true)
      try await host.open()
      try await wait { await f.service.pending != nil }
      let close = Task { try await host.close() }
      try await wait { host.requiresReopen }
      let other = f.host()
      try await rejects { try await other.open() }
      try await other.close()
      try check(f.sources.isEmpty && f.runs.isEmpty)
      await f.service.release()
      try await close.value
      try check(host.phase == .closed)
      let reopened = f.host()
      try await reopened.open()
      try await reopened.start()
      let intents = await f.service.leaseIntents
      try check(intents.count == 2 && Set(intents).count == 1)
      try check(await f.service.issues == 1)
      try check(f.runs.count == 1)
      try await reopened.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      var now = Date()
      let host = f.host(now: { now })
      await f.service.configure(now: now)
      try await host.open()
      try await host.start()
      let key = f.keys.value
      let intent = host.saved!.completionIntent
      now = now.addingTimeInterval(901)
      await f.service.configure(hold: true, now: now)
      try await host.pause()
      try await wait { await f.service.pending != nil }
      try check(f.runs[0].isPhysicallyIdle && host.saved!.committedChunks == 1)
      let seal = Task { try await host.sealForUpload() }
      try await wait { f.runs[0].stopCalls == 2 }
      try check(f.sources.count == 1 && f.runs.count == 1)
      await f.service.release()
      try await seal.value
      let intents = await f.service.leaseIntents
      try check(intents.count == 3 && intents[1] == intents[2])
      try check(await f.service.renewals == 1)
      try check(await f.service.reservationSizes == [30])
      try check(host.phase == .sealed && host.saved!.committedChunks == 1)
      try check(host.saved!.completionIntent == intent && f.keys.value == key)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      let key = f.keys.value
      let intent = host.saved!.completionIntent
      try await host.start()
      f.records.failSeal = true
      try await rejects { try await host.sealForUpload() }
      try check(host.phase == .paused && host.failure == .recoveryFailed)
      try check(host.saved!.committedChunks == 1 && f.runs[0].captureState.committedChunks == 1)
      let retained = f.records.rows
      f.records.failSeal = false
      f.records.failInventory = true
      try await rejects { try await host.start() }
      try check(host.phase == .paused && host.failure == .recoveryFailed && f.runs.count == 1)
      try check(f.sources.count == 1)
      f.records.failInventory = false
      try await host.start()
      try check(host.phase == .recording && f.runs[1].first == 1 && f.runs[1].prior == 204)
      try check(f.keys.value == key && host.saved!.completionIntent == intent)
      for (name, row) in retained where name.hasPrefix("scribe-provider-queue:") {
        try check(f.records.rows[name]?.data == row.data)
      }
      try await host.sealForUpload()
      try check(host.phase == .sealed && host.saved!.committedChunks == 2)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      let intent = host.saved!.completionIntent
      let key = f.keys.value
      try await host.start()
      f.records.loseSealReply = true
      try await rejects { try await host.sealForUpload() }
      try check(host.phase == .paused && host.failure == .recoveryFailed)
      f.records.loseSealReply = false
      try await rejects { try await host.start() }
      try check(host.phase == .sealed && f.runs.count == 1 && f.sources.count == 1)
      try check(host.saved!.completionIntent == intent && f.keys.value == key)
      let sealed = host.saved
      try await host.sealForUpload()
      try check(host.saved == sealed && host.saved!.committedChunks == 1)
      try await host.close()
      checks += 1
    }
    do {
      // Use the real PCM sink: its byte count is local to the current interval.
      // A shorter resumed interval must add to, not replace, the saved visit.
      let f = try Fixture()
      let bridge = NativeProviderRecordingBridge()
      let revision = UUID().uuidString.lowercased()
      let selection = try NativeProviderRecordingSelection([
        "requestId": UUID().uuidString.lowercased(), "revision": revision,
        "workspaceId": f.scope.workspaceID.uuidString.lowercased(),
        "sessionId": f.scope.sessionID.uuidString.lowercased(),
        "bindingRef": "scribe_capture_binding_01j00000000000000000000000",
      ])
      let opened = try await bridge.open(
        selection, current: {}, make: { f.host() }, inputMuted: { false })
      let id = (opened["recording"] as! [String: Any])["recorderId"] as! String
      let key = f.keys.value
      func command(_ kind: String, bytes: Int, chunks: Int, ok: Bool = true) async throws {
        let reply = try await bridge.command(
          NativeProviderRecordingCommand([
            "requestId": UUID().uuidString.lowercased(), "revision": revision,
            "recorderId": id, "kind": kind,
          ]), current: {}, inputMuted: { false })
        try check(reply["ok"] as? Bool == ok)
        if kind == "close" { return }
        let state = reply["recording"] as! [String: Any]
        try check(state["recordedPlaintextBytes"] as? Int == bytes)
        try check(state["recordedChunks"] as? Int == chunks)
        try check(state["capturedAudioFrames"] as? Int == (bytes - chunks * 44) / 2)
      }
      try await command("start", bytes: 0, chunks: 0)
      try f.runs[0].emit(320_000)
      try await command("read", bytes: 320_044, chunks: 1)
      try await command("pause", bytes: 320_044, chunks: 1)
      let retained = try f.records.rows.filter { row in
        guard row.key.hasPrefix("scribe-provider-queue:") else { return false }
        return (try JSONSerialization.jsonObject(with: row.value.data) as? [String: Any])?["state"]
          as? String == "encrypted"
      }
      try check(retained.count == 1)
      try await command("start", bytes: 320_044, chunks: 1)
      try f.runs[1].emit(64_000)
      try await command("read", bytes: 384_088, chunks: 2)
      f.runs[1].failStop = true
      try await command("pause", bytes: 384_088, chunks: 2, ok: false)
      f.runs[1].failStop = false
      try await command("pause", bytes: 384_088, chunks: 2)
      try await command("read", bytes: 384_088, chunks: 2)
      try await command("start", bytes: 384_088, chunks: 2)
      try check(await f.service.reservations == 1)
      try check(await f.service.reservationSizes == [30])
      try check(f.sources.count == 3 && f.sources[0].confirmed && f.sources[1].confirmed)
      try f.runs[2].emit(32_000)
      try await command("read", bytes: 416_132, chunks: 3)
      try await command("seal", bytes: 416_132, chunks: 3)
      try await command("read", bytes: 416_132, chunks: 3)
      try check(f.keys.value == key)
      for (name, row) in retained {
        try check(
          f.records.rows[name]?.data == row.data && f.records.rows[name]?.revision == row.revision)
      }
      try await command("close", bytes: 0, chunks: 0)
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      let key = f.keys.value
      let intent = host.saved!.completionIntent
      try check(host.phase == .ready && f.sources.isEmpty && f.runs.isEmpty)
      let bindings = await f.service.bindings
      try check(bindings == 1)
      let other = f.host()
      try await rejects { try await other.open() }
      try await other.close()
      try await host.selectMicrophoneInput(.external)
      try check(host.microphoneInput == .external)
      try await host.start()
      try await host.selectMicrophoneInput(.bluetooth)
      try check(host.phase == .recording && host.microphoneInput == .bluetooth)
      try check(f.runs.count == 2 && f.runs[1].first == 1 && f.runs[1].prior == 204)
      try check(host.saved!.completionIntent == intent && f.keys.value == key)
      try await host.pause()
      try check(host.saved!.committedChunks == 2 && host.saved!.committedPlaintextBytes == 408)
      try await host.close()
      let reopened = f.host()
      try await reopened.open()
      try check(
        reopened.phase == .paused && reopened.saved!.completionIntent == intent
          && f.keys.value == key)
      try await reopened.start()
      try check(f.runs[2].first == 2 && f.runs[2].prior == 408)
      try await reopened.sealForUpload()
      try check(
        reopened.phase == .sealed && reopened.saved!.committedChunks == 3
          && reopened.saved!.committedPlaintextBytes == 612)
      let sealed = reopened.saved
      try await reopened.close()
      f.records.rows = f.records.rows.filter { !$0.key.hasPrefix("scribe-provider-queue:") }
      let purged = f.host()
      try await purged.open()
      try check(purged.saved == sealed && purged.phase == .sealed && f.keys.value == key)
      try await rejects { try await purged.start() }
      try await purged.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      await f.service.configure(hold: true)
      try await host.open()
      let first = Task { try await host.start() }
      let duplicate = Task { try await host.start() }
      try await wait { await f.service.pending != nil }
      try await host.pause()
      await f.service.release()
      try await rejects { try await first.value }
      try await rejects { try await duplicate.value }
      try check(host.phase == .paused && f.sources.isEmpty && f.runs.isEmpty)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      await f.service.configure(expired: true)
      try await host.open()
      try await host.start()
      try check(await f.service.renewals == 1)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      try await host.start()
      f.runs[0].failStop = true
      try await rejects { try await host.selectMicrophoneInput(.bluetooth) }
      try check(host.phase == .stopPending && f.runs.count == 1 && host.microphoneInput == .builtIn)
      // A failed physical/Core stop cannot turn an input choice into another
      // source interval. Retry Pause keeps the already committed audio.
      f.runs[0].failStop = false
      try await host.pause()
      try check(host.phase == .paused && host.saved!.committedChunks == 1)
      try await host.close()
      checks += 1
    }
    for stopFails in [false, true] {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      f.failFactory = true
      f.failSourceStop = stopFails
      try await rejects { try await host.start() }
      try check(
        f.sources.count == 1 && f.sources[0].stops == 1
          && host.phase == (stopFails ? .stopPending : .paused))
      f.sources[0].failStop = false
      try await host.pause()
      try check(host.phase == .paused && host.failure != .stopPending)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      try await host.start()
      f.runs[0].failStop = true
      try await rejects { try await host.sealForUpload() }
      try check(
        host.phase == .stopPending && host.saved!.phase == .incomplete && f.runs[0].isPhysicallyIdle)
      try await rejects { try await host.start() }
      f.runs[0].failStop = false
      try await host.sealForUpload()
      try check(host.phase == .sealed && host.saved!.committedChunks == 1)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      try await host.start()
      f.runs[0].empty = true
      try await rejects { try await host.sealForUpload() }
      try check(host.saved!.phase == .open && host.phase == .paused)
      try await host.start()
      try check(host.phase == .recording && f.runs[1].first == 0)
      try await host.sealForUpload()
      try check(host.phase == .sealed && host.saved!.committedChunks == 1)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      await f.service.configure(hold: true)
      try await host.open()
      let start = Task { try await host.start() }
      try await wait { await f.service.pending != nil }
      host.retire()
      f.deny = true
      await f.service.release()
      try await rejects { try await start.value }
      try await host.close()
      try check(f.sources.isEmpty && f.runs.isEmpty)
      checks += 1
    }
    do {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      try await host.start()
      try f.runs[0].emit()
      let retained = f.records.rows
      f.runs[0].incomplete = true
      try await rejects { try await host.pause() }
      try check(host.failure == .recordingIncomplete && host.phase == .stopPending)
      for _ in 0..<2 { try await rejects { try await host.sealForUpload() } }
      try await rejects { try await host.start() }
      try check(host.failure == .recordingIncomplete && host.saved!.phase == .incomplete)
      try check(f.runs.count == 1 && f.runs[0].captureState.committedChunks == 1)
      for (key, row) in retained { try check(f.records.rows[key]?.data == row.data) }
      try await host.close()
      let reopened = f.host()
      try await reopened.open()
      try check(reopened.failure == .recordingIncomplete && reopened.saved!.phase == .incomplete)
      try check(reopened.saved!.committedChunks == 1)
      try await rejects { try await reopened.start() }
      try await rejects { try await reopened.sealForUpload() }
      try check(f.runs.count == 1)
      try await reopened.close()
      checks += 1
    }
    do {
      let f = try Fixture(), host = f.host()
      try await host.open()
      f.records.failCheckpoint = true
      try await rejects { try await host.start() }
      try check(f.sources.isEmpty && f.runs.isEmpty)
      f.records.failCheckpoint = false
      try await host.close()
      let reopened = f.host()
      try await reopened.open()
      try await reopened.start()
      try await reopened.pause()
      try await reopened.close()
      let successful = f.host()
      try await successful.open()
      try check(successful.failure == nil && successful.saved!.phase == .open)
      try await successful.sealForUpload()
      try await successful.close()
      checks += 1
    }
    for retryStop in [false, true] {
      let f = try Fixture()
      let host = f.host()
      try await host.open()
      try await host.start()
      let key = f.keys.value
      f.runs[0].failStop = retryStop
      if retryStop {
        try await rejects { try f.runs[0].stop() }
        try await rejects { try await host.refresh() }
        try check(host.phase == .stopPending && host.failure == .stopPending)
        f.runs[0].failStop = false
        try await host.pause()
      } else {
        try f.runs[0].stop()
        try await host.refresh()
      }
      try check(host.phase == .paused && host.failure == .captureInterrupted)
      try check(host.saved!.committedChunks == 1 && f.runs.count == 1 && f.keys.value == key)
      try await host.refresh()
      try check(host.failure == .captureInterrupted && f.runs.count == 1)
      try await host.start()
      try check(host.phase == .recording && host.failure == nil && f.runs.count == 2)
      try await host.pause()
      try check(host.phase == .paused && host.failure == nil)
      try check(host.saved!.committedChunks == 2 && f.keys.value == key)
      try await host.close()
      checks += 1
    }
    do {
      let f = try Fixture()
      let bridge = NativeProviderRecordingBridge()
      let revision = UUID().uuidString.lowercased()
      let raw: [String: Any] = [
        "requestId": UUID().uuidString.lowercased(), "revision": revision,
        "workspaceId": f.scope.workspaceID.uuidString.lowercased(),
        "sessionId": f.scope.sessionID.uuidString.lowercased(),
        "bindingRef": "scribe_capture_binding_01j00000000000000000000000",
      ]
      let selection = try NativeProviderRecordingSelection(raw)
      let opened = try await bridge.open(
        selection, current: {}, make: { f.host() }, inputMuted: { false })
      let state = opened["recording"] as! [String: Any]
      let id = state["recorderId"] as! String
      try check(state["phase"] as? String == "ready" && f.sources.isEmpty)
      try check(JSONSerialization.isValidJSONObject(opened))
      try check(bridge.navigationMetadata(revision: revision) == nil)
      func command(_ kind: String, revision override: String? = nil) throws
        -> NativeProviderRecordingCommand
      {
        try NativeProviderRecordingCommand([
          "requestId": UUID().uuidString.lowercased(), "revision": override ?? revision,
          "recorderId": id, "kind": kind,
        ])
      }
      try await rejects {
        _ = try await bridge.command(
          command("start", revision: UUID().uuidString.lowercased()), current: {},
          inputMuted: { false })
      }
      let changed = try Fixture()
      try await rejects {
        _ = try await bridge.open(
          selection, current: {}, make: { changed.host() }, inputMuted: { false })
      }
      _ = try await bridge.command(command("start"), current: {}, inputMuted: { false })
      let navigation = bridge.navigationMetadata(revision: revision)
      try check(navigation?["workspaceId"] as? String == f.scope.workspaceID.uuidString.lowercased())
      try check(navigation?["sessionId"] as? String == f.scope.sessionID.uuidString.lowercased())
      try check(Set(navigation!.keys) == ["workspaceId", "sessionId"] && f.runs.count == 1)
      try check(bridge.navigationMetadata(revision: UUID().uuidString.lowercased()) == nil)
      f.runs[0].failStop = true
      let failed = try await bridge.command(
        command("close"), current: { throw Failed(line: #line) }, inputMuted: { true })
      try check(failed["ok"] as? Bool == false && failed["recording"] is NSNull)
      f.runs[0].failStop = false
      let closed = try await bridge.command(
        command("close"), current: { throw Failed(line: #line) }, inputMuted: { true })
      try check(closed["ok"] as? Bool == true && closed["recording"] is NSNull)
      try check(bridge.navigationMetadata(revision: revision) == nil)
      let duplicate = try await bridge.command(command("close"), current: {}, inputMuted: { false })
      try check(duplicate["ok"] as? Bool == true && f.sources[0].stops == 1)
      checks += 1
    }
    do {
      let f = try Fixture()
      let bridge = NativeProviderRecordingBridge()
      let revision = UUID().uuidString.lowercased()
      let raw: [String: Any] = [
        "requestId": UUID().uuidString.lowercased(), "revision": revision,
        "workspaceId": f.scope.workspaceID.uuidString.lowercased(),
        "sessionId": f.scope.sessionID.uuidString.lowercased(),
        "bindingRef": "scribe_capture_binding_01j00000000000000000000000",
      ]
      let selection = try NativeProviderRecordingSelection(raw)
      await f.service.configure(failAll: true)
      let opened = try await bridge.open(
        selection, current: {}, make: { f.host() }, inputMuted: { false })
      let state = opened["recording"] as! [String: Any]
      let id = state["recorderId"] as! String
      try check(opened["ok"] as? Bool == false && state["phase"] as? String == "failed")
      await f.service.configure()
      let retried = try await bridge.open(
        selection, current: {}, make: { f.host() }, inputMuted: { false })
      let next = retried["recording"] as! [String: Any]
      try check(next["recorderId"] as? String == id && next["phase"] as? String == "ready")
      let close = try NativeProviderRecordingCommand([
        "requestId": UUID().uuidString.lowercased(), "revision": revision,
        "recorderId": id, "kind": "close",
      ])
      _ = try await bridge.command(close, current: {}, inputMuted: { false })
      checks += 1
    }
    do {
      let raw: [String: Any] = [
        "requestId": UUID().uuidString.lowercased(), "revision": UUID().uuidString.lowercased(),
        "workspaceId": UUID().uuidString.lowercased(), "sessionId": UUID().uuidString.lowercased(),
        "bindingRef": "scribe_capture_binding_01j00000000000000000000000",
      ]
      for key in raw.keys {
        var missing = raw
        missing.removeValue(forKey: key)
        try await rejects { _ = try NativeProviderRecordingSelection(missing) }
      }
      var extra = raw
      extra["audio"] = Data()
      try await rejects { _ = try NativeProviderRecordingSelection(extra) }
      var invalid = raw
      invalid["revision"] = UUID().uuidString.uppercased()
      try await rejects { _ = try NativeProviderRecordingSelection(invalid) }
      let command: [String: Any] = [
        "requestId": UUID().uuidString.lowercased(), "revision": UUID().uuidString.lowercased(),
        "recorderId": UUID().uuidString.lowercased(), "kind": "input", "input": "external",
      ]
      _ = try NativeProviderRecordingCommand(command)
      var injected = command
      injected["kind"] = "start"
      try await rejects { _ = try NativeProviderRecordingCommand(injected) }
      checks += 1
    }
    return checks
  }
}
