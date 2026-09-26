import Foundation

public struct NativeRecordingReservation: Codable, Equatable, Sendable {
  public let objectID: UUID
  public let sessionID: UUID
  public let sequence: Int
  public let additionalData: String
  public let createdAt: String

  public init(
    scope: NativeRecordingScope, objectID: UUID, sequence: Int,
    additionalData: String, createdAt: String
  ) throws {
    guard (0..<2048).contains(sequence), additionalData.utf8.count <= 1024,
      NativeRecordingLease.date(createdAt) != nil,
      try nativeBase64URLDecode(additionalData)
        == scope.additionalData(objectID: objectID, sequence: sequence)
    else { throw NativeRecordingFailure.invalidBinding }
    self.objectID = objectID
    sessionID = scope.sessionID
    self.sequence = sequence
    self.additionalData = additionalData
    self.createdAt = createdAt
  }

  func validated(scope: NativeRecordingScope) throws -> Self {
    guard sessionID == scope.sessionID else { throw NativeRecordingFailure.invalidBinding }
    return try Self(
      scope: scope, objectID: objectID, sequence: sequence,
      additionalData: additionalData, createdAt: createdAt)
  }

  var queueValue: [String: Any] {
    [
      "protocolVersion": "1.0", "objectId": objectID.uuidString.lowercased(),
      "sessionId": sessionID.uuidString.lowercased(), "channel": "microphone",
      "sequenceNumber": sequence, "additionalAuthenticatedData": additionalData,
      "createdAt": createdAt,
    ]
  }
}

public struct NativeRecordingReservationBatch: Codable, Equatable, Sendable {
  public let batchID: UUID
  public let sessionID: UUID
  public let authorizedUntil: String
  public let reservations: [NativeRecordingReservation]

  public init(
    batchID: UUID, sessionID: UUID, authorizedUntil: String,
    reservations: [NativeRecordingReservation]
  ) {
    self.batchID = batchID
    self.sessionID = sessionID
    self.authorizedUntil = authorizedUntil
    self.reservations = reservations
  }

  func validate(scope: NativeRecordingScope, lease: NativeRecordingLease, first: Int, count: Int)
    throws
  {
    guard sessionID == scope.sessionID, lease.sessionID == scope.sessionID,
      authorizedUntil == lease.expiresAt, reservations.count == count,
      Set(reservations.map(\.objectID)).count == count
    else { throw NativeRecordingFailure.invalidBinding }
    _ = try lease.validated()
    for (offset, value) in reservations.enumerated() {
      guard value.sequence == first + offset else { throw NativeRecordingFailure.invalidBinding }
      _ = try value.validated(scope: scope)
    }
  }
}

public protocol NativeRecordingReservationService: Sendable {
  func recordingScope() async throws -> NativeRecordingScope
  func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) async throws
    -> NativeRecordingReservationBatch
}

extension NativeRecordingScope {
  func additionalData(objectID: UUID, sequence: Int) throws -> Data {
    try JSONSerialization.data(
      withJSONObject: [
        "channel": "microphone", "object_id": objectID.uuidString.lowercased(),
        "sequence_number": sequence, "session_id": sessionID.uuidString.lowercased(),
        "tenant_id": tenantID.uuidString.lowercased(),
      ], options: [.sortedKeys, .withoutEscapingSlashes])
  }

  func queuePrefix(recoveryScope: UUID) -> String {
    "scribe-provider-queue:v1:\(recoveryScope.uuidString.lowercased()):\(workspaceID.uuidString.lowercased()):\(sessionID.uuidString.lowercased()):"
  }
}
