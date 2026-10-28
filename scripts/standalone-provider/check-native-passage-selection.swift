import Foundation

@MainActor enum NativePassageSelectionChecks {
  private struct Failed: Error { let line: UInt }
  private static func check(_ value: Bool, line: UInt = #line) throws { if !value { throw Failed(line: line) } }
  static func run() throws -> Int {
    let session = UUID().uuidString.lowercased(), segment = UUID().uuidString.lowercased()
    let workspace = UUID().uuidString.lowercased(), nonce = UUID().uuidString.lowercased()
    let binding = "scribe_capture_binding_01m5x6bf6ffp2bggh1ng2ca18p"
    let input: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "revision": UUID().uuidString.lowercased(),
      "workspaceId": workspace, "bindingRef": binding, "sessionId": session, "segmentId": segment]
    let selected = try NativeProviderPassageSelection(input), now = Date()
    let stamp = ISO8601DateFormatter().string(from: now)
    var envelope: [String: Any] = ["contract_version": "1", "binding_ref": binding, "workspace_id": workspace,
      "request_nonce": nonce, "checked_at": stamp, "operation": "creator_review", "receipt": ["schema_version": "1.0",
        "session_id": session, "source": ["segments": [["source_segment_id": segment, "start_ms": 100, "end_ms": 60_000]]]]]
    func reply(_ value: [String: Any], status: Int = 200) throws -> ProviderNativeReply {
      ProviderNativeReply(status: status, body: try JSONSerialization.data(withJSONObject: value))
    }
    let range = try selected.range(reply: reply(envelope), nonce: nonce, now: now)
    try check(range?.0 == 100 && range?.1 == 30_100)
    var checks = 1
    for key in ["binding_ref", "workspace_id", "request_nonce", "operation", "contract_version", "checked_at"] {
      var changed = envelope; changed[key] = key == "checked_at" ? "2020-01-01T00:00:00Z" : "other"
      do { _ = try selected.range(reply: reply(changed), nonce: nonce, now: now); throw Failed(line: #line) }
      catch is Failed { throw Failed(line: #line) } catch { checks += 1 }
    }
    var extra = input;extra["startMs"] = 0
    do { _ = try NativeProviderPassageSelection(extra);throw Failed(line: #line) }
    catch is Failed { throw Failed(line: #line) } catch { checks += 1 }
    for rows: [[String: Any]] in [
      [["source_segment_id": segment, "start_ms": true, "end_ms": 100]],
      [["source_segment_id": segment, "start_ms": 2, "end_ms": 1]],
      [["source_segment_id": segment, "start_ms": 0, "end_ms": 100], ["source_segment_id": segment, "start_ms": 100, "end_ms": 200]]
    ] {
      var changed = envelope;changed["receipt"] = ["schema_version": "1.0", "session_id": session, "source": ["segments": rows]]
      do { _ = try selected.range(reply: reply(changed), nonce: nonce, now: now);throw Failed(line: #line) }
      catch is Failed { throw Failed(line: #line) } catch { checks += 1 }
    }
    let sourceID = UUID().uuidString.lowercased()
    let continuity: [String: Any] = ["schema_version": "1.0", "continuity": "interrupted_or_unconfirmed", "missing_audio": "unknown",
      "starts": [["source_start_id": sourceID, "first_sequence_number": 0],
        ["source_start_id": UUID().uuidString.lowercased(), "first_sequence_number": 3]]]
    var view = envelope["receipt"] as! [String: Any];view["capture_continuity"] = continuity
    envelope["receipt"] = view
    let restarted = try selected.range(reply: reply(envelope), nonce: nonce, now: now)
    try check(restarted?.0 == 100 && restarted?.1 == 30_100 && restarted?.3 == [0, 3]);checks += 1
    try check((envelope["receipt"] as? [String: Any])?["capture_continuity"] as? NSDictionary == continuity as NSDictionary);checks += 1
    for bad: [String: Any] in [[:], ["schema_version": "1.0", "continuity": "interrupted_or_unconfirmed", "missing_audio": "unknown",
      "starts": [["source_start_id": sourceID, "first_sequence_number": 0], ["source_start_id": sourceID, "first_sequence_number": 3]]],
      ["schema_version": "1.0", "continuity": "interrupted_or_unconfirmed", "missing_audio": "unknown",
      "starts": [["source_start_id": sourceID, "first_sequence_number": 0], ["source_start_id": UUID().uuidString.lowercased(), "first_sequence_number": true]]]
    ] {
      var changed = envelope;var v = view;v["capture_continuity"] = bad;changed["receipt"] = v
      do { _ = try selected.range(reply: reply(changed), nonce: nonce, now: now);throw Failed(line: #line) }
      catch is Failed { throw Failed(line: #line) } catch { checks += 1 }
    }
    for age in [31.0, -6.0] {
      do { try NativeProviderPassageSelection.requireFresh(now.addingTimeInterval(-age), now: now);throw Failed(line: #line) }
      catch is Failed { throw Failed(line: #line) } catch { checks += 1 }
    }
    print("native passage selection checks passed: \(checks)")
    return checks
  }
}
