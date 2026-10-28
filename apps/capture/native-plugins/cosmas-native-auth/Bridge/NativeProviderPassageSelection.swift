import CoreFoundation
import Foundation

struct NativeProviderPassageSelection {
  let requestID: UUID, workspaceID: UUID, sessionID: UUID, segmentID: UUID
  let revision: String, bindingRef: String
  init(_ value: [String: Any]) throws {
    guard Set(value.keys) == ["requestId", "revision", "workspaceId", "bindingRef", "sessionId", "segmentId"],
      let binding = value["bindingRef"] as? String,
      binding.range(of: "^scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression) != nil else { throw ProviderNativeError.invalidRequest }
    requestID = try Self.uuid(value["requestId"]);workspaceID = try Self.uuid(value["workspaceId"])
    sessionID = try Self.uuid(value["sessionId"]);segmentID = try Self.uuid(value["segmentId"])
    revision = try Self.uuid(value["revision"]).uuidString.lowercased();bindingRef = binding
  }
  static func uuid(_ value: Any?) throws -> UUID {
    guard let text = value as? String, let id = UUID(uuidString: text), id.uuidString.lowercased() == text else { throw ProviderNativeError.invalidRequest };return id
  }
  /// Parse only fresh, server-selected passage metadata. Transcript content is
  /// neither logged nor returned to this bridge. Declared restart boundaries
  /// must also be proven against the complete native archive before playback.
  @MainActor func range(reply: ProviderNativeReply, nonce: String, now: Date = Date()) throws -> (Int, Int, Date, [Int]?)? {
    try NativeProviderConnection.requireRecordingResponse(reply.status)
    guard reply.status == 200, reply.body.count <= 32 * 1024 * 1024 + 8192,
      let e = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
      Set(e.keys) == ["contract_version", "binding_ref", "workspace_id", "request_nonce", "checked_at", "operation", "receipt"],
      e["contract_version"] as? String == "1", e["binding_ref"] as? String == bindingRef,
      e["workspace_id"] as? String == workspaceID.uuidString.lowercased(), e["request_nonce"] as? String == nonce,
      e["operation"] as? String == "creator_review", let checked = e["checked_at"] as? String,
      let date = Self.date(checked), (-5...30).contains(now.timeIntervalSince(date)),
      let view = e["receipt"] as? [String: Any], view["schema_version"] as? String == "1.0",
      view["session_id"] as? String == sessionID.uuidString.lowercased() else { throw ProviderNativeError.response }
    let restarts = try Self.restartSequences(view["capture_continuity"])
    guard let source = view["source"] as? [String: Any] else { return nil }
    guard let segments = source["segments"] as? [[String: Any]], segments.count <= 10_000 else { throw ProviderNativeError.response }
    var seen = Set<UUID>(), selected: (Int, Int)?
    for row in segments {
      let id = try Self.uuid(row["source_segment_id"])
      guard seen.insert(id).inserted, let start = Self.integer(row["start_ms"]), let end = Self.integer(row["end_ms"]),
        start >= 0, end > start, end <= 12_600_000 else { throw ProviderNativeError.response }
      if id == segmentID { selected = (start, min(end, start + 30_000)) }
    }
    return selected.map { ($0.0, $0.1, date, restarts) }
  }
  /// This is the closed Core continuity contract, not an assertion that missing
  /// speech exists or that wall-clock pause time belongs in the mixed PCM track.
  private static func restartSequences(_ value: Any?) throws -> [Int]? {
    guard let value, !(value is NSNull) else { return nil }
    guard let evidence = value as? [String: Any],
      Set(evidence.keys) == ["schema_version", "continuity", "missing_audio", "starts"],
      evidence["schema_version"] as? String == "1.0",
      evidence["continuity"] as? String == "interrupted_or_unconfirmed",
      evidence["missing_audio"] as? String == "unknown",
      let starts = evidence["starts"] as? [[String: Any]], (2...1000).contains(starts.count)
    else { throw ProviderNativeError.response }
    var seen = Set<UUID>(), positions = [Int]()
    for start in starts {
      guard Set(start.keys) == ["source_start_id", "first_sequence_number"],
        let position = integer(start["first_sequence_number"]), position < 2048,
        position >= (positions.last ?? 0), !positions.isEmpty || position == 0
      else { throw ProviderNativeError.response }
      let id = try uuid(start["source_start_id"])
      guard seen.insert(id).inserted else { throw ProviderNativeError.response }
      positions.append(position)
    }
    return positions
  }
  static func requireFresh(_ checkedAt: Date, now: Date = Date()) throws {
    guard (-5...30).contains(now.timeIntervalSince(checkedAt)) else { throw ProviderNativeError.response }
  }
  private static func integer(_ value: Any?) -> Int? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
      (0...12_600_000).contains(n.doubleValue), n.doubleValue.rounded() == n.doubleValue else { return nil };return n.intValue
  }
  private static func date(_ text: String) -> Date? {
    guard text.utf8.count <= 40 else { return nil }
    let p = ISO8601DateFormatter();p.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let value = p.date(from: text) { return value };p.formatOptions = [.withInternetDateTime];return p.date(from: text)
  }
}
