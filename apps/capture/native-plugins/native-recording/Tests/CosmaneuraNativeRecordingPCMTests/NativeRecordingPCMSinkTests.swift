import CosmaneuraNativeRecording
import CosmaneuraNativeRecordingPCM
import Foundation
import Security
import XCTest

@testable import CosmaneuraIOSPCMCore

@MainActor final class NativeRecordingPCMSinkTests: XCTestCase {
  func testFirstPacketPersistenceBracketAndFailureContainOnlyMetadata() async throws {
    for fails in [false, true] {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
      defer { try? FileManager.default.removeItem(at: directory) }
      let file = directory.appendingPathComponent("diagnostics.json"), diagnostics = PCMStartupDiagnostics()
      diagnostics.configure(destination: file)
      let fixture = try Fixture(), sink = try fixture.sink(diagnostics: diagnostics)
      try sink.stage(await fixture.reserve(0, 2))
      if fails { fixture.records.fault = "before" }
      let first = PCMEncodedPacket(sequenceNumber: 0, bytes: OwnedPCMBytes([0, 0]))
      if fails { XCTAssertThrowsError(try sink.emit(first)) }
      else {
        _ = try sink.emit(first)
        _ = try sink.emit(PCMEncodedPacket(sequenceNumber: 1, bytes: OwnedPCMBytes([0, 0])))
      }
      XCTAssertTrue(first.bytes.isZeroed)
      await diagnostics.flush()
      let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
      XCTAssertEqual(rows.compactMap { $0["event"] as? String }, ["firstPacketPersistenceStarted",
        fails ? "packetPersistenceFailed" : "firstPacketPersistenceCompleted"])
      XCTAssertTrue(rows.allSatisfy { Set($0.keys) == ["utc", "event", "clock", "monotonic_ns", "capture_attempt", "dropped_events"] })
    }
  }

  private final class Keys: NativeRecordingKeyStorage, @unchecked Sendable {
    var value: Data?
    func read(account: String) throws -> Data? { value }
    func insert(account: String, value: Data) throws {
      guard self.value == nil else { throw NativeRecordingFailure.keyConflict }
      self.value = value
    }
  }

  private final class Records: NativeRecordingBindingRecordStore, NativeRecordingRecordStore,
    @unchecked Sendable
  {
    let lock = NSLock()
    var values: [String: NativeRecordingStoredRecord] = [:]
    var fault = "none"
    var available = 2_000_000_000
    var writes = 0
    func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
      lock.withLock { values[key] }
    }
    func read(key: String) throws -> NativeRecordingStoredRecord {
      try XCTUnwrap(readBinding(key: key))
    }
    func createBinding(key: String, data: Data) throws { try write(key, 0, data) }
    func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, expectedRevision, data)
    }
    func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, expectedRevision, data)
    }
    func availableBytes() throws -> Int { available }
    func write(_ key: String, _ expected: UInt64, _ data: Data) throws {
      try lock.withLock {
        guard values[key]?.revision ?? 0 == expected, fault != "before" else {
          throw NativeRecordingFailure.storageUnavailable
        }
        writes += 1
        values[key] = NativeRecordingStoredRecord(data: data, revision: expected + 1)
        if fault == "after" { throw NativeRecordingFailure.storageUnavailable }
      }
    }
  }

  private struct Allocations: NativeRecordingReservationService {
    let scope: NativeRecordingScope
    func recordingScope() async throws -> NativeRecordingScope { scope }
    func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) async throws
      -> NativeRecordingReservationBatch
    {
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
          additionalData: encode(aad), createdAt: "2026-09-26T00:00:00Z")
      }
      return NativeRecordingReservationBatch(
        batchID: UUID(), sessionID: scope.sessionID,
        authorizedUntil: lease.expiresAt, reservations: rows)
    }
  }

  private struct Fixture {
    let scope: NativeRecordingScope
    let recovery = UUID()
    let records = Records()
    let cipher: NativeRecordingEncryption
    init(allPartiesConsented: Bool = true) throws {
      // Explicit synthetic consent; no device, live account or ambient microphone.
      guard allPartiesConsented else { throw NativeRecordingFailure.invalidBinding }
      scope = try NativeRecordingScope(
        tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
        accountDigest: String(repeating: "a", count: 64))
      let key = try XCTUnwrap(
        SecKeyCreateRandomKey(
          [
            kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072,
            kSecAttrIsPermanent: false,
          ] as CFDictionary, nil))
      let der =
        try XCTUnwrap(
          SecKeyCopyExternalRepresentation(
            XCTUnwrap(SecKeyCopyPublicKey(key)), nil)) as Data
      cipher = try NativeRecordingEncryption.create(
        scope: scope,
        published: NativeRecordingPublicKey(
          version: "synthetic-v1",
          modulusBase64URL: encode(der.subdata(in: 9..<393))), storage: Keys())
    }
    func sink(first: Int = 0, prior: Int = 0, maximum: Int = 402_653_184,
      diagnostics: PCMStartupDiagnostics = .shared) throws
      -> NativeRecordingPCMSink
    {
      try NativeRecordingPCMSink(
        encryption: cipher, recoveryScope: recovery, records: records,
        firstSequence: first, priorPlaintextBytes: prior, maximumPlaintextBytes: maximum, diagnostics: diagnostics)
    }
    func reserve(_ first: Int, _ count: Int) async throws -> NativeRecordingReservationBatch {
      let lease = try NativeRecordingLease(
        receiptID: UUID(), leaseID: UUID(),
        sessionID: scope.sessionID, generation: 1,
        issuedAt: "2026-09-26T00:00:00Z", expiresAt: "2026-09-26T00:15:00Z")
      return try await NativeRecordingReservationOwner(
        scope: scope, recoveryScope: recovery,
        service: Allocations(scope: scope), records: records
      ).reserve(lease: lease, first: first, count: count)
    }
    func stored(_ sequence: Int) throws -> NativeRecordingStoredRecord {
      let suffix = String(format: "10000000-0000-4000-8000-%012d", sequence + 1)
      return try records.read(
        key:
          "scribe-provider-queue:v1:\(recovery.uuidString.lowercased()):\(scope.workspaceID.uuidString.lowercased()):\(scope.sessionID.uuidString.lowercased()):\(suffix)"
      )
    }
  }

  private struct SyntheticConsent: MicrophonePermissionAuthorizing {
    func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
      cancellation.isCancelled ? .unavailable : .granted
    }
  }
  private actor Driver: PCMAudioDriving {
    var callbacks: PCMAudioCallbacks?
    var frozen = false
    func start(sessionID: UInt64, callbacks: PCMAudioCallbacks, cancellation: StartupCancellation)
      async throws
    {
      guard !cancellation.isCancelled else { throw PCMFailure(.startupCancelled) }
      self.callbacks = callbacks
    }
    func offer(_ count: Int) async throws {
      let frames = OwnedAudioFrames(
        sampleRateHz: 16_000, channels: [Array(repeating: 0.25, count: count)])
      let admission = try XCTUnwrap(callbacks).frames(frames)
      XCTAssertTrue(admission.accepted)
      await admission.waitUntilConsumed()
      XCTAssertTrue(frames.isZeroed)
    }
    func freezeInput(sessionID: UInt64) async throws {
      callbacks = nil
      frozen = true
    }
    func release(sessionID: UInt64) async throws {}
  }

  func testActualPCMCoreCommitsFullAndFinalPartialWithoutWebView() async throws {
    let fixture = try Fixture()
    let driver = Driver()
    let sink = try fixture.sink(first: 40)
    try sink.stage(await fixture.reserve(40, 3))
    let core = IOSPCMCore(permission: SyntheticConsent(), audio: driver, sink: sink)
    let session = try core.start(
      configuration: PCMConfiguration(
        targetFramesPerChunk: 160,
        maximumChunks: 3, maximumInputFramesPerBuffer: 160))
    try await session.ready()
    try await driver.offer(160)
    try await driver.offer(160)
    try await driver.offer(80)
    let stopped = try await session.stop(.drain)
    try sink.finish(stopped)
    XCTAssertTrue(stopped.finalPacket?.bytes.isZeroed ?? true)
    XCTAssertEqual(sink.state.phase, .closed)
    XCTAssertEqual(sink.state.nextSequence, 43)
    XCTAssertEqual(sink.state.committedPlaintextBytes, 800 + 3 * 44)
    XCTAssertEqual(sink.state.pendingReservations, 0)
    for position in 40..<43 {
      let record = try fixture.stored(position)
      XCTAssertEqual(record.revision, 2)
      let value = try JSONSerialization.jsonObject(with: record.data) as! [String: Any]
      XCTAssertEqual(value["state"] as? String, "encrypted")
    }
    XCTAssertThrowsError(try sink.finish(stopped))
    let frozen = await driver.frozen
    XCTAssertTrue(frozen)
  }

  func testStorageFailureAcknowledgesOnlyDurableCommitAndClearsPCM() async throws {
    for fault in ["before", "after", "low-space"] {
      let fixture = try Fixture()
      let sink = try fixture.sink()
      try sink.stage(await fixture.reserve(0, 2))
      fixture.records.fault = fault
      if fault == "low-space" { fixture.records.available = 0 }
      let packet = PCMEncodedPacket(sequenceNumber: 0, bytes: OwnedPCMBytes([1, 0, 2, 0]))
      if fault == "after" {
        let acknowledgement = try sink.emit(packet)
        acknowledgement.cancel()
        let result = await acknowledgement.wait()
        guard case .accepted = result else {
          return XCTFail("committed packet was not acknowledged")
        }
        XCTAssertEqual(sink.state.committedChunks, 1)
        XCTAssertEqual(try fixture.stored(0).revision, 2)
      } else {
        XCTAssertThrowsError(try sink.emit(packet))
        XCTAssertEqual(sink.state.committedChunks, 0)
        XCTAssertEqual(sink.state.phase, .failed)
        XCTAssertEqual(try fixture.stored(0).revision, 1)
      }
      XCTAssertTrue(packet.bytes.isZeroed)
    }
  }

  func testReplenishmentPreservesConcurrentProgressAndRejectsWrongScope() async throws {
    let fixture = try Fixture()
    let sink = try fixture.sink()
    let first = try await fixture.reserve(0, 3)
    try sink.stage(first)
    _ = try sink.emit(PCMEncodedPacket(sequenceNumber: 0, bytes: OwnedPCMBytes([1, 0])))
    let retained = try fixture.stored(0)
    try sink.stage(first)  // The response can arrive after one earlier packet committed.
    XCTAssertEqual(sink.state.pendingReservations, 2)
    try sink.stage(await fixture.reserve(1, 3))
    XCTAssertEqual(sink.state.pendingReservations, 3)
    let invalid = NativeRecordingReservationBatch(
      batchID: UUID(), sessionID: UUID(),
      authorizedUntil: first.authorizedUntil, reservations: first.reservations)
    XCTAssertThrowsError(try sink.stage(invalid))
    XCTAssertEqual(sink.state.pendingReservations, 3)
    XCTAssertEqual(try fixture.stored(0).data, retained.data)
    let duplicate = PCMEncodedPacket(sequenceNumber: 0, bytes: OwnedPCMBytes([1, 0]))
    XCTAssertThrowsError(try sink.emit(duplicate))
    XCTAssertTrue(duplicate.bytes.isZeroed)
    XCTAssertEqual(try fixture.stored(0).data, retained.data)
  }

  func testSourceWindowClosureAllowsOnlyOneDrainedPartial() async throws {
    let fixture = try Fixture()
    let sink = try fixture.sink()
    try sink.stage(await fixture.reserve(0, 2))
    sink.windowClosed(.authorityExpired)
    XCTAssertEqual(sink.state.phase, .draining)
    let rejected = PCMEncodedPacket(sequenceNumber: 0, bytes: OwnedPCMBytes([1, 0]))
    XCTAssertThrowsError(try sink.emit(rejected))
    XCTAssertTrue(rejected.bytes.isZeroed)
    let final = PCMEncodedPacket(sequenceNumber: 0, bytes: OwnedPCMBytes([2, 0]))
    let stopped = PCMStopResult(finalPacket: final)
    let commit = try sink.finish(stopped)
    XCTAssertEqual(commit?.sequence, 0)
    XCTAssertTrue(final.bytes.isZeroed)
    XCTAssertThrowsError(try sink.finish(stopped))
    XCTAssertEqual(try fixture.stored(0).revision, 2)
  }

  func testMissingReservationPositionLimitAndTerminationNeverAcceptAudio() async throws {
    for kind in ["missing", "sequence", "limit", "terminated"] {
      let fixture = try Fixture()
      let sink = try fixture.sink(maximum: kind == "limit" ? 45 : 402_653_184)
      if kind != "missing" { try sink.stage(await fixture.reserve(0, 1)) }
      if kind == "terminated" { sink.terminated(.routeChanged) }
      let packet = PCMEncodedPacket(
        sequenceNumber: kind == "sequence" ? UInt64.max : 0,
        bytes: OwnedPCMBytes([1, 0]))
      let before = fixture.records.writes
      XCTAssertThrowsError(try sink.emit(packet))
      XCTAssertTrue(packet.bytes.isZeroed)
      XCTAssertEqual(fixture.records.writes, before)
      XCTAssertEqual(sink.state.committedChunks, 0)
    }
  }

  func testRollingThreeHourPositionBudgetKeepsAtMostTwoReservationWindows() async throws {
    let fixture = try Fixture()
    let sink = try fixture.sink()
    let first = try await fixture.reserve(0, 90)
    let second = try await fixture.reserve(90, 90)
    let third = try await fixture.reserve(180, 90)
    try sink.stage(first)
    try sink.stage(second)
    XCTAssertThrowsError(try sink.stage(third))
    XCTAssertEqual(sink.state.pendingReservations, 180)
    // Accelerated position/replenishment check; packet-volume and real-clock
    // capture are separate tests. No elapsed three-hour recording is claimed.
    for sequence in 0..<1080 {
      if sequence >= 180 && sequence.isMultiple(of: 90) {
        if sequence == 180 {
          try sink.stage(third)
        } else {
          try sink.stage(await fixture.reserve(sequence, 90))
        }
      }
      let packet = PCMEncodedPacket(sequenceNumber: UInt64(sequence), bytes: OwnedPCMBytes([1, 0]))
      let acknowledgement = try sink.emit(packet)
      let result = await acknowledgement.wait()
      guard case .accepted = result else { return XCTFail("packet was not durable") }
      XCTAssertTrue(packet.bytes.isZeroed)
      XCTAssertLessThanOrEqual(sink.state.pendingReservations, 180)
    }
    try sink.finish(PCMStopResult(finalPacket: nil))
    XCTAssertEqual(sink.state.committedChunks, 1080)
    XCTAssertEqual(sink.state.committedPlaintextBytes, 1080 * 46)
    XCTAssertEqual(sink.state.phase, .closed)
  }
}

private func encode(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
