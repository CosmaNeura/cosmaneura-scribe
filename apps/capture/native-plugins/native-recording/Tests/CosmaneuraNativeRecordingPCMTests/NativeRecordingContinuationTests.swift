import CosmaneuraIOSAVFoundationDriver
import CosmaneuraIOSPCMCore
import CosmaneuraNativeRecording
import Foundation
import Security
import XCTest

@testable import CosmaneuraNativeRecordingPCM

@MainActor final class NativeRecordingContinuationTests: XCTestCase {
  func testThreeHoursUseActualPCMEncryptionAndFourteenShortLeases() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open()
    for chunk in 0..<1_080 {
      assertTrue(await owner.heartbeatAndObserve())
      await owner.maintain()
      // Five bounded callbacks represent one full ten-second packet. The entire
      // 172.8 million-frame visit goes through the production PCM and cipher.
      for _ in 0..<5 { try await f.driver.offer(32_000) }
      f.clock.advance(10)
      assertEqual(f.sink.state.committedChunks, chunk + 1)
      XCTAssertLessThanOrEqual(f.sink.state.pendingReservations, 90)
    }
    try await owner.stop()
    let state = await owner.state
    assertEqual(state.phase, .stopped)
    XCTAssertNil(state.reason)
    assertEqual(state.sourceGeneration, 14)
    assertEqual(state.capture.committedChunks, 1_080)
    assertEqual(state.capture.committedPlaintextBytes, 345_600_000 + 1_080 * 44)
    assertEqual(f.records.encryptedCount, 1_080)
    let counts = await f.service.counts
    assertEqual(counts.leases, 14)
    assertEqual(counts.batches, 14)
    assertEqual(await f.driver.starts, 1)
    assertEqual(await f.driver.releases, 1)
    assertEqual(state.capture.phase, .closed)
  }

  func testLostLeaseReplyReplaysExactIntentWithoutExtendingEarly() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open()
    f.clock.advance(780)
    await f.service.loseNextLeaseReply()
    await owner.maintain()
    var state = await owner.state
    assertEqual(state.phase, .renewalDelayed)
    assertEqual(state.sourceGeneration, 1)
    await owner.maintain()
    state = await owner.state
    assertEqual(state.phase, .recording)
    assertEqual(state.sourceGeneration, 2)
    let calls = await f.service.leaseIntents
    assertEqual(calls.count, 3)
    assertEqual(calls[1], calls[2])
    // No new audio consumed: unused positions are retained without allocating
    // another full ninety-position window just because time advanced.
    assertEqual(state.reservedThroughSequence, 90)
    try await owner.stop()
  }

  func testExplicitCoreDenialStopsBeforeTheOldDeadline() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open()
    try await f.driver.offer(800)
    f.clock.advance(780)  // Two minutes of the old window still remain.
    await f.service.denyNextLease()
    await owner.maintain()
    let state = await owner.state
    assertEqual(state.phase, .stopped)
    assertEqual(state.reason, .sourceRetired)
    assertEqual(state.sourceGeneration, 1)
    assertEqual(state.capture.committedChunks, 1)
    assertEqual(await f.driver.releases, 1)
  }

  func testReservationRetryRetainsLeaseAndRangeWhileAudioProgresses() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open()
    try await f.driver.offerPacket()
    f.clock.advance(780)
    await f.service.loseNextBatchReply()
    await owner.maintain()
    assertEqual((await owner.state).phase, .renewalDelayed)
    try await f.driver.offerPacket()
    await owner.maintain()
    let state = await owner.state
    assertEqual(state.sourceGeneration, 2)
    assertEqual(state.reservedThroughSequence, 91)
    let calls = await f.service.batchCalls
    assertEqual(calls.count, 3)
    assertEqual(calls[1], calls[2])
    assertEqual((await f.service.counts).leases, 2)
    try await owner.stop()
    assertEqual(state.capture.committedChunks, 2)
  }

  func testStopWinsAgainstLateRenewalAndDrainsPartialOnce() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open()
    try await f.driver.offer(800)
    f.clock.advance(780)
    let pause = ContinuationPause()
    await f.service.pauseRenewal(pause)
    let renewal = Task { await owner.maintain() }
    await pause.entered()
    try await owner.stop()
    await pause.release()
    await renewal.value
    try await owner.stop()
    let state = await owner.state
    assertEqual(state.phase, .stopped)
    assertEqual(state.sourceGeneration, 1)
    assertEqual(state.capture.committedChunks, 1)
    assertEqual(state.capture.committedPlaintextBytes, 1_644)
    assertEqual((await f.service.counts).batches, 1)
    assertEqual(await f.driver.releases, 1)
  }

  func testDeadlineWinsAgainstLateRenewalEvenWithWallClockRollback() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open()
    try await f.driver.offer(800)
    f.clock.advance(780)
    let pause = ContinuationPause()
    await f.service.pauseRenewal(pause)
    let renewal = Task { await owner.maintain() }
    await pause.entered()
    f.clock.advance(121, wallOffset: -300)
    await pause.release()
    await renewal.value
    let state = await owner.state
    assertEqual(state.phase, .stopped)
    assertEqual(state.reason, .authorityExpired)
    assertEqual(state.sourceGeneration, 1)
    assertEqual(state.capture.committedChunks, 1)
    assertEqual((await f.service.counts).batches, 1)
  }

  func testSourceRetirementStopsPendingRenewalWithoutRestart() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open()
    f.clock.advance(780)
    let pause = ContinuationPause()
    await f.service.pauseRenewal(pause)
    let renewal = Task { await owner.maintain() }
    await pause.entered()
    await f.fence.retire()
    assertFalse(await owner.heartbeatAndObserve())
    await pause.release()
    await renewal.value
    let state = await owner.state
    assertEqual(state.phase, .stopped)
    assertEqual(state.reason, .sourceRetired)
    assertEqual(state.sourceGeneration, 1)
    assertEqual(await f.driver.starts, 1)
  }

  func testFailedPhysicalClosureRemainsRetryableAndKeepsPartial() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open()
    try await f.driver.offer(800)
    await f.driver.failNextFreeze()
    do {
      try await owner.stop()
      XCTFail("Unconfirmed closure must fail")
    } catch {}
    assertEqual((await owner.state).reason, .closureUnconfirmed)
    assertEqual(f.sink.state.committedChunks, 0)
    try await owner.stop()
    assertEqual((await owner.state).phase, .stopped)
    assertEqual(f.sink.state.committedChunks, 1)
    assertEqual(await f.driver.releases, 1)
  }

  func testWrongSourceHandleCannotBeAdopted() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open(start: false, wrongRun: true)
    do {
      try await owner.startMaintenance()
      XCTFail("A different native source must not be adopted")
    } catch {}
    assertEqual((await owner.state).phase, .stopped)
    assertEqual(await f.driver.releases, 1)
  }

  func testNativeHeartbeatRunsWhileNetworkRenewalIsSuspended() async throws {
    let f = try ContinuationFixture()
    let owner = try await f.open(start: false)
    let pause = ContinuationPause()
    await f.service.pauseRenewal(pause)
    f.clock.advance(780)
    try await owner.startMaintenance()
    await pause.entered()
    // Let three actual native heartbeat periods pass: no WebView or test-driven
    // heartbeat. This exceeds the core's fifteen-second watchdog interval.
    try await Task.sleep(for: .seconds(16))
    try await f.driver.offer(800)
    assertEqual(f.sink.state.phase, .accepting)
    try await owner.stop()
    await pause.release()
    assertEqual(f.sink.state.committedChunks, 1)
  }

  func testEncryptedNativeGraphKeepsLargerTapAfterBackground() async throws {
    let f = try ContinuationFixture()
    let system = EncryptedAudioSystem()
    let recorder = try f.recorder(system: system)
    let lease = try await f.leases.open()
    let batch = try await f.reservations.reserve(lease: lease, first: 0, count: 90)
    try recorder.start(
      runID: UUID().uuidString.lowercased(),
      captureExpiresAtMilliseconds: f.clock.now().epochMilliseconds + 900_000,
      lease: lease, batch: batch)
    try await recorder.ready()
    try await recorder.ready()  // Repeated UI readiness joins the same native start.
    assertFalse(recorder.isPhysicallyIdle)
    assertEqual(system.profile, .nativeEncryptedSpeech)
    system.emit(.backgrounded)
    let frames = try system.offer(8_192)
    for _ in 0..<1_000 {
      if frames.isZeroed { break }
      try await Task.sleep(for: .milliseconds(1))
    }
    assertTrue(frames.isZeroed)
    assertEqual((await recorder.snapshot())?.phase, .recording)
    assertEqual(recorder.captureSignal().convertedBuffers, 1)
    try await recorder.stop()
    assertTrue(recorder.isPhysicallyIdle)
    assertEqual(recorder.captureState.committedChunks, 1)
    assertEqual(recorder.captureState.committedPlaintextBytes, 8_192 * 2 + 44)
    assertEqual(f.records.encryptedCount, 1)
    assertEqual(system.deactivations, 1)
    try await recorder.stop()
    assertEqual(system.deactivations, 1)
  }

  func testNativeGraphRejectsLowStorageBeforeClaimAndSupportsThreeHourBudget() async throws {
    let f = try ContinuationFixture()
    let system = EncryptedAudioSystem()
    let required = try NativeEncryptedPCMRecorder.requiredAvailableBytes(priorPlaintextBytes: 0)
    XCTAssertGreaterThan(
      NativeEncryptedPCMRecorder.maximumPlaintextBytes,
      NativeEncryptedPCMRecorder.threeHourPlaintextBytes)
    f.records.setCapacity(required - 1)
    XCTAssertThrowsError(try f.recorder(system: system))
    f.records.setCapacity(required)
    let recorder = try f.recorder(system: system)
    let lease = try await f.leases.open()
    let batch = try await f.reservations.reserve(lease: lease, first: 0, count: 90)
    f.records.setCapacity(required - 1)
    XCTAssertThrowsError(
      try recorder.start(
        runID: UUID().uuidString.lowercased(),
        captureExpiresAtMilliseconds: f.clock.now().epochMilliseconds + 900_000,
        lease: lease, batch: batch))
    assertTrue(recorder.isPhysicallyIdle)
    assertEqual(system.activations, 0)
    try await recorder.stop()
  }

  func testNativeGraphStillRequiresForegroundStart() async throws {
    let f = try ContinuationFixture()
    let system = EncryptedAudioSystem()
    let recorder = try f.recorder(system: system, foreground: false)
    let lease = try await f.leases.open()
    let batch = try await f.reservations.reserve(lease: lease, first: 0, count: 90)
    try recorder.start(
      runID: UUID().uuidString.lowercased(),
      captureExpiresAtMilliseconds: f.clock.now().epochMilliseconds + 900_000,
      lease: lease, batch: batch)
    do {
      try await recorder.ready()
      XCTFail("Background start must fail")
    } catch {}
    try await recorder.stop()
    assertTrue(recorder.isPhysicallyIdle)
    assertEqual(system.activations, 0)
  }

  func testNativeGraphKeepsHandleAfterPostClaimValidationFailure() async throws {
    let f = try ContinuationFixture()
    let system = EncryptedAudioSystem()
    let recorder = try f.recorder(system: system)
    let lease = try await f.leases.open()
    let batch = try await f.reservations.reserve(lease: lease, first: 0, count: 90)
    XCTAssertThrowsError(
      try recorder.start(
        runID: UUID().uuidString.lowercased(),
        captureExpiresAtMilliseconds: f.clock.now().epochMilliseconds + 899_000,
        lease: lease, batch: batch))
    assertFalse(recorder.isPhysicallyIdle)
    try await recorder.stop()
    assertTrue(recorder.isPhysicallyIdle)
    assertEqual(recorder.captureState.committedChunks, 0)
  }

  func testNativeGraphRouteChangeAfterBackgroundStillClosesCapture() async throws {
    let f = try ContinuationFixture()
    let system = EncryptedAudioSystem()
    let recorder = try f.recorder(system: system)
    let lease = try await f.leases.open()
    let batch = try await f.reservations.reserve(lease: lease, first: 0, count: 90)
    try recorder.start(
      runID: UUID().uuidString.lowercased(),
      captureExpiresAtMilliseconds: f.clock.now().epochMilliseconds + 900_000,
      lease: lease, batch: batch)
    try await recorder.ready()
    system.emit(.backgrounded)
    system.emit(.routeChanged)
    for _ in 0..<1_000 {
      if recorder.captureState.phase == .failed { break }
      try await Task.sleep(for: .milliseconds(1))
    }
    assertEqual(recorder.captureState.phase, .failed)
    try await recorder.stop()
    assertTrue(recorder.isPhysicallyIdle)
  }
}

// Values are awaited before entering XCTest's non-async autoclosures.
private func assertTrue(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) {
  XCTAssertTrue(value, file: file, line: line)
}
private func assertFalse(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) {
  XCTAssertFalse(value, file: file, line: line)
}
private func assertEqual<T: Equatable>(
  _ value: T, _ expected: T,
  file: StaticString = #filePath, line: UInt = #line
) {
  XCTAssertEqual(value, expected, file: file, line: line)
}

private final class ContinuationClock: PCMSourceClock, @unchecked Sendable {
  private let lock = NSLock()
  private var seconds: Int64 = 0
  private var wall: Int64 = 0
  func advance(_ seconds: Int64, wallOffset: Int64 = 0) {
    lock.withLock {
      self.seconds += seconds
      wall += wallOffset
    }
  }
  func now() -> PCMSourceTime {
    lock.withLock {
      PCMSourceTime(
        epochMilliseconds: 1_790_000_000_000 + (seconds + wall) * 1_000,
        monotonicNanoseconds: UInt64(seconds) * 1_000_000_000)
    }
  }
  func sleep(nanoseconds: UInt64) async throws { try await Task.sleep(nanoseconds: nanoseconds) }
  func date(_ extra: Int64 = 0) -> String {
    ISO8601DateFormatter().string(
      from: Date(timeIntervalSince1970: Double(now().epochMilliseconds + extra * 1_000) / 1_000))
  }
}

private actor ContinuationPause {
  private var waiting: CheckedContinuation<Void, Never>?
  private var observers: [CheckedContinuation<Void, Never>] = []
  func block() async {
    await withCheckedContinuation { continuation in
      waiting = continuation
      for observer in observers { observer.resume() }
      observers.removeAll()
    }
  }
  func entered() async {
    if waiting != nil { return }
    await withCheckedContinuation { observers.append($0) }
  }
  func release() {
    waiting?.resume()
    waiting = nil
  }
}

private actor ContinuationFence {
  private var retired = false
  func retire() { retired = true }
  func validate() throws {
    if retired { throw NativeRecordingBindingFailure.authorityChanged }
  }
}

private actor ContinuationService: NativeRecordingLeaseService, NativeRecordingReservationService {
  struct BatchCall: Equatable {
    let first: Int
    let count: Int
    let intent: UUID
  }
  let scope: NativeRecordingScope
  let clock: ContinuationClock
  private var leases: [UUID: NativeRecordingLease] = [:]
  private var batches: [UUID: NativeRecordingReservationBatch] = [:]
  var leaseIntents: [UUID] = []
  var batchCalls: [BatchCall] = []
  private var lostLease = false
  private var deniedLease = false
  private var lostBatch = false
  private var pause: ContinuationPause?
  init(_ scope: NativeRecordingScope, _ clock: ContinuationClock) {
    self.scope = scope
    self.clock = clock
  }
  var counts: (leases: Int, batches: Int) { (leases.count, batches.count) }
  func recordingScope() async throws -> NativeRecordingScope { scope }
  func loseNextLeaseReply() { lostLease = true }
  func denyNextLease() { deniedLease = true }
  func loseNextBatchReply() { lostBatch = true }
  func pauseRenewal(_ value: ContinuationPause) { pause = value }
  func requestLease(previous: NativeRecordingLease?, intent: UUID) async throws
    -> NativeRecordingLease
  {
    leaseIntents.append(intent)
    if deniedLease {
      deniedLease = false
      throw NativeRecordingBindingFailure.authorityChanged
    }
    let value: NativeRecordingLease
    if let retained = leases[intent] {
      value = retained
    } else {
      value = try NativeRecordingLease(
        receiptID: UUID(), leaseID: previous?.leaseID ?? UUID(), sessionID: scope.sessionID,
        generation: (previous?.generation ?? 0) + 1,
        issuedAt: clock.date(), expiresAt: clock.date(900))
      leases[intent] = value
    }
    if previous != nil, let pause {
      self.pause = nil
      await pause.block()
    }
    if lostLease {
      lostLease = false
      throw URLError(.networkConnectionLost)
    }
    return value
  }
  func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) async throws
    -> NativeRecordingReservationBatch
  {
    batchCalls.append(BatchCall(first: first, count: count, intent: intent))
    let value: NativeRecordingReservationBatch
    if let retained = batches[intent] {
      value = retained
    } else {
      let rows = try (first..<(first + count)).map { sequence in
        let object = UUID(
          uuidString: String(format: "10000000-0000-4000-8000-%012d", sequence + 1))!
        let aad = try JSONSerialization.data(
          withJSONObject: [
            "channel": "microphone", "object_id": object.uuidString.lowercased(),
            "sequence_number": sequence, "session_id": scope.sessionID.uuidString.lowercased(),
            "tenant_id": scope.tenantID.uuidString.lowercased(),
          ], options: [.sortedKeys, .withoutEscapingSlashes])
        return try NativeRecordingReservation(
          scope: scope, objectID: object, sequence: sequence,
          additionalData: continuationEncode(aad), createdAt: clock.date())
      }
      value = NativeRecordingReservationBatch(
        batchID: UUID(), sessionID: scope.sessionID, authorizedUntil: lease.expiresAt,
        reservations: rows)
      batches[intent] = value
    }
    if lostBatch {
      lostBatch = false
      throw URLError(.networkConnectionLost)
    }
    return value
  }
}

private final class ContinuationRecords: NativeRecordingBindingRecordStore,
  NativeRecordingLeaseRecordStore, NativeRecordingRecordStore, @unchecked Sendable
{
  private let lock = NSLock()
  private var values: [String: NativeRecordingStoredRecord] = [:]
  private var encrypted = 0
  private var capacity = 2_000_000_000
  func setCapacity(_ value: Int) { lock.withLock { capacity = value } }
  var encryptedCount: Int { lock.withLock { encrypted } }
  func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
    lock.withLock { values[key] }
  }
  func readLease(key: String) throws -> NativeRecordingStoredRecord? { try readBinding(key: key) }
  func read(key: String) throws -> NativeRecordingStoredRecord {
    try XCTUnwrap(readBinding(key: key))
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
    lock.withLock { encrypted += 1 }
  }
  func availableBytes() throws -> Int { lock.withLock { capacity } }
  private func write(_ key: String, _ revision: UInt64, _ data: Data) throws {
    try lock.withLock {
      guard values[key]?.revision ?? 0 == revision else {
        throw NativeRecordingBindingFailure.journalConflict
      }
      values[key] = NativeRecordingStoredRecord(data: data, revision: revision + 1)
    }
  }
}

private actor ContinuationDriver: PCMAudioDriving {
  private var callbacks: PCMAudioCallbacks?
  private var badFreeze = false
  var starts = 0
  var releases = 0
  func start(sessionID: UInt64, callbacks: PCMAudioCallbacks, cancellation: StartupCancellation)
    async throws
  {
    guard !cancellation.isCancelled else { throw PCMFailure(.startupCancelled) }
    self.callbacks = callbacks
    starts += 1
  }
  func offer(_ count: Int) async throws {
    let frames = OwnedAudioFrames(
      sampleRateHz: 16_000, channels: [Array(repeating: 0.125, count: count)])
    let admission = try XCTUnwrap(callbacks).frames(frames)
    assertTrue(admission.accepted)
    await admission.waitUntilConsumed()
    assertTrue(frames.isZeroed)
  }
  func offerPacket() async throws { for _ in 0..<5 { try await offer(32_000) } }
  func failNextFreeze() { badFreeze = true }
  func freezeInput(sessionID: UInt64) async throws {
    if badFreeze {
      badFreeze = false
      throw PCMFailure(.stopFailed)
    }
    callbacks = nil
  }
  func release(sessionID: UInt64) async throws { releases += 1 }
}

private struct ContinuationConsent: MicrophonePermissionAuthorizing {
  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    cancellation.isCancelled ? .unavailable : .granted
  }
}

@MainActor private struct ContinuationFixture {
  private final class Keys: NativeRecordingKeyStorage, @unchecked Sendable {
    private var value: Data?
    func read(account: String) throws -> Data? { value }
    func insert(account: String, value: Data) throws {
      guard self.value == nil else { throw NativeRecordingFailure.keyConflict }
      self.value = value
    }
  }
  let clock = ContinuationClock()
  let records = ContinuationRecords()
  let driver = ContinuationDriver()
  let fence = ContinuationFence()
  let recovery = UUID()
  let cipher: NativeRecordingEncryption
  let sink: NativeRecordingPCMSink
  let service: ContinuationService
  let leases: NativeRecordingLeaseOwner
  let reservations: NativeRecordingReservationOwner
  init(allPartiesConsented: Bool = true) throws {
    // Consent precedes every generated frame. No live identity, disk queue,
    // network request, microphone, playback or user-attended test is used.
    guard allPartiesConsented else { throw NativeRecordingFailure.invalidBinding }
    let scope = try NativeRecordingScope(
      tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
      accountDigest: String(repeating: "a", count: 64))
    let key = try XCTUnwrap(
      SecKeyCreateRandomKey(
        [
          kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072,
          kSecAttrIsPermanent: false,
        ] as CFDictionary, nil))
    let der =
      try XCTUnwrap(SecKeyCopyExternalRepresentation(XCTUnwrap(SecKeyCopyPublicKey(key)), nil))
      as Data
    cipher = try NativeRecordingEncryption.create(
      scope: scope,
      published: NativeRecordingPublicKey(
        version: "synthetic-v1", modulusBase64URL: continuationEncode(der.subdata(in: 9..<393))),
      storage: Keys())
    sink = try NativeRecordingPCMSink(
      encryption: cipher, recoveryScope: recovery, records: records, firstSequence: 0,
      priorPlaintextBytes: 0)
    service = ContinuationService(scope, clock)
    leases = NativeRecordingLeaseOwner(scope: scope, service: service, records: records)
    reservations = NativeRecordingReservationOwner(
      scope: scope, recoveryScope: recovery, service: service, records: records)
  }
  func recorder(system: EncryptedAudioSystem, foreground: Bool = true) throws
    -> NativeEncryptedPCMRecorder
  {
    try NativeEncryptedPCMRecorder(
      encryption: cipher, recoveryScope: recovery, records: records,
      firstSequence: 0, priorPlaintextBytes: 0, leases: leases, reservations: reservations,
      permission: ContinuationConsent(), system: system,
      foreground: EncryptedForeground(active: foreground), signal: PCMSignalMonitor(),
      sourceClock: clock, validateActiveSource: { [fence] in try await fence.validate() })
  }
  func open(start: Bool = true, wrongRun: Bool = false) async throws -> NativeRecordingContinuation
  {
    let lease = try await leases.open()
    let batch = try await reservations.reserve(lease: lease, first: 0, count: 90)
    try sink.stage(batch)
    let authority = try PCMSourceAuthority(
      runID: UUID().uuidString.lowercased(), generation: 1,
      expiresAtMilliseconds: clock.now().epochMilliseconds + 900_000, hardMaximumChunks: 2_048)
    let core = IOSPCMCore(
      permission: ContinuationConsent(), audio: driver, sink: sink, sourceClock: clock)
    let handle = try core.start(
      configuration: PCMConfiguration(
        targetFramesPerChunk: 160_000, maximumChunks: 90, maximumInputFramesPerBuffer: 32_000,
        authority: authority))
    let supplied = try PCMSourceAuthority(
      runID: wrongRun ? UUID().uuidString.lowercased() : authority.runID, generation: 1,
      expiresAtMilliseconds: authority.expiresAtMilliseconds, hardMaximumChunks: 2_048)
    let owner = try NativeRecordingContinuation(
      session: handle, sink: sink, leases: leases, reservations: reservations,
      initialLease: lease, initialAuthority: supplied, initialBatch: batch, sourceClock: clock,
      validateActiveSource: { [fence] in try await fence.validate() })
    if start { try await owner.beginMaintenance(automatic: false) }
    return owner
  }
}

private func continuationEncode(_ value: Data) -> String {
  value.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

private struct EncryptedForeground: AppleApplicationForegroundProviding {
  let active: Bool
  func isForegroundActive() async -> Bool { active }
}

private final class EncryptedAudioSystem: AppleAudioSystem, @unchecked Sendable {
  private let lock = NSLock()
  private var events: (@Sendable (AppleAudioSystemEvent) -> Void)?
  private var frames: (@Sendable (OwnedAudioFrames) -> Void)?
  private var selectedProfile: AppleAudioSessionProfile?
  private var activated = 0
  private var deactivated = 0
  var profile: AppleAudioSessionProfile? { lock.withLock { selectedProfile } }
  var activations: Int { lock.withLock { activated } }
  var deactivations: Int { lock.withLock { deactivated } }
  func setEventHandler(_ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void) {
    lock.withLock { events = handler }
  }
  func clearEventHandler() { lock.withLock { events = nil } }
  func configureAndActivate(profile: AppleAudioSessionProfile) throws {
    lock.withLock {
      selectedProfile = profile
      activated += 1
    }
  }
  func installInputTap(
    frameCapacity: UInt32,
    handler: @escaping @Sendable (OwnedAudioFrames) -> Void
  ) throws {
    lock.withLock { frames = handler }
  }
  func startEngine() throws {}
  func freezeInput() throws { lock.withLock { frames = nil } }
  func deactivate() throws { lock.withLock { deactivated += 1 } }
  func emit(_ event: AppleAudioSystemEvent) { lock.withLock { events }?(event) }
  func offer(_ count: Int) throws -> OwnedAudioFrames {
    let value = OwnedAudioFrames(
      sampleRateHz: 16_000, channels: [Array(repeating: 0.125, count: count)])
    try XCTUnwrap(lock.withLock { frames })(value)
    return value
  }
}
