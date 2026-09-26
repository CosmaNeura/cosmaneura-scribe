import CosmaneuraIOSAVFoundationDriver
import CosmaneuraNativeRecording
import CosmasNativeAuth
import Foundation

struct NativeProviderRecordingSelection {
  let requestID: UUID, revision: String, workspaceID: UUID, bindingRef: String, sessionID: UUID
  init(_ value: [String: Any]) throws {
    guard Set(value.keys) == ["requestId", "revision", "workspaceId", "bindingRef", "sessionId"],
      let binding = value["bindingRef"] as? String,
      binding.range(
        of: "^scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression)
        != nil
    else { throw ProviderNativeError.invalidRequest }
    requestID = try recordingUUID(value["requestId"])
    revision = try recordingUUID(value["revision"]).uuidString.lowercased()
    workspaceID = try recordingUUID(value["workspaceId"])
    sessionID = try recordingUUID(value["sessionId"])
    bindingRef = binding
  }
}

struct NativeProviderRecordingCommand {
  enum Kind: String { case read, start, pause, seal, close, input }
  let requestID: UUID, recorderID: UUID, revision: String, kind: Kind
  let input: AppleMicrophoneInput?
  init(_ value: [String: Any]) throws {
    guard let raw = value["kind"] as? String, let kind = Kind(rawValue: raw),
      Set(value.keys)
        == Set(["requestId", "recorderId", "revision", "kind"] + (kind == .input ? ["input"] : []))
    else { throw ProviderNativeError.invalidRequest }
    requestID = try recordingUUID(value["requestId"])
    recorderID = try recordingUUID(value["recorderId"])
    revision = try recordingUUID(value["revision"]).uuidString.lowercased()
    self.kind = kind
    if kind == .input {
      guard let raw = value["input"] as? String, let input = AppleMicrophoneInput(rawValue: raw)
      else { throw ProviderNativeError.invalidRequest }
      self.input = input
    } else {
      input = nil
    }
  }
}

private func recordingUUID(_ value: Any?) throws -> UUID {
  guard let raw = value as? String, let id = UUID(uuidString: raw),
    raw == id.uuidString.lowercased()
  else { throw ProviderNativeError.invalidRequest }
  return id
}

/// Retained by the native process, not a renderer component. Only fixed metadata
/// crosses Capacitor. The actual factory always rechecks the Core mount/context.
@MainActor final class NativeProviderRecordingBridge {
  private struct Entry {
    let id: UUID, selection: NativeProviderRecordingSelection, host: NativeProviderRecordingHost
  }
  private var entry: Entry?
  private var openingRevision: String?
  private var generation = UUID()
  private var lastClosed: UUID?
  private var version = 0

  func authChanged(_ state: NativeAuthState) {
    let expected = entry?.selection.revision ?? openingRevision
    if expected != nil && (state.phase != .ready || state.revision != expected) {
      generation = UUID()
      entry?.host.retire()
    }
  }

  func open(
    _ selection: NativeProviderRecordingSelection,
    current: @MainActor () throws -> Void,
    make: @MainActor () async throws -> NativeProviderRecordingHost,
    inputMuted: @MainActor () -> Bool
  ) async throws -> [String: Any] {
    try current()
    guard openingRevision == nil else { throw ProviderNativeError.unavailable }
    openingRevision = selection.revision
    defer { openingRevision = nil }
    let ticket = generation
    let candidate = try await make()  // No source/key creation before open().
    try current()
    guard generation == ticket, candidate.scope.workspaceID == selection.workspaceID,
      candidate.scope.sessionID == selection.sessionID
    else { throw ProviderNativeError.authorityChanged }
    if let previous = entry {
      guard previous.host.scope == candidate.scope,
        previous.host.recoveryScope == candidate.recoveryScope,
        previous.selection.bindingRef == selection.bindingRef
      else { throw ProviderNativeError.unavailable }
      if previous.selection.revision != selection.revision || previous.host.requiresReopen {
        // Same account/visit verified again: retire the old source before a new
        // host can recover. Never adopt its previous start permission.
        try await previous.host.close()
        try current()
        guard generation == ticket, entry?.id == previous.id else {
          throw ProviderNativeError.unavailable
        }
        entry = nil
      }
    }
    if entry == nil { entry = Entry(id: UUID(), selection: selection, host: candidate) }
    guard let selected = entry else { throw ProviderNativeError.unavailable }
    var ok = true
    do { try await selected.host.open() } catch { ok = false }
    try current()
    guard generation == ticket, entry?.id == selected.id else {
      throw ProviderNativeError.unavailable
    }
    return response(selection.requestID, ok, selected, inputMuted: inputMuted())
  }

  func command(
    _ request: NativeProviderRecordingCommand,
    current: @MainActor () throws -> Void, inputMuted: @MainActor () -> Bool
  ) async throws -> [String: Any] {
    if request.kind == .close, request.recorderID == lastClosed {
      return response(request.requestID, true, nil, inputMuted: false)
    }
    guard let selected = entry, selected.id == request.recorderID else {
      throw ProviderNativeError.unavailable
    }
    if request.kind == .close {
      // Stop is allowed after renderer auth invalidation, but never returns
      // private state. Core still verifies the original account's stop proof.
      generation = UUID()
      do {
        try await selected.host.close()
        guard entry?.id == selected.id else { throw ProviderNativeError.unavailable }
        entry = nil
        lastClosed = selected.id
        return response(request.requestID, true, nil, inputMuted: false)
      } catch { return response(request.requestID, false, nil, inputMuted: false) }
    }
    try current()
    guard selected.selection.revision == request.revision else {
      throw ProviderNativeError.authorityChanged
    }
    var ok = true
    do {
      switch request.kind {
      case .read: try await selected.host.refresh()
      case .start:
        if selected.host.phase != .recording { try await selected.host.start() }
      case .pause: try await selected.host.pause()
      case .seal: try await selected.host.sealForUpload()
      case .input: try selected.host.selectMicrophoneInput(request.input!)
      case .close: throw ProviderNativeError.invalidRequest
      }
    } catch { ok = false }
    try current()
    guard entry?.id == selected.id else { throw ProviderNativeError.unavailable }
    return response(request.requestID, ok, selected, inputMuted: inputMuted())
  }

  private func response(_ id: UUID, _ ok: Bool, _ selected: Entry?, inputMuted: Bool) -> [String:
    Any]
  {
    [
      "requestId": id.uuidString.lowercased(), "ok": ok,
      "recording": selected.map { payload($0, inputMuted: inputMuted) } as Any? ?? NSNull(),
    ]
  }

  private func payload(_ entry: Entry, inputMuted: Bool) -> [String: Any] {
    version += 1
    let host = entry.host
    let saved = host.saved
    let live = host.phase == .sealed ? nil : host.captureState
    let count = max(saved?.committedChunks ?? 0, live?.nextSequence ?? 0)
    let bytes = max(saved?.committedPlaintextBytes ?? 0, live?.committedPlaintextBytes ?? 0)
    let completion: [String: Any]? = saved?.completionLease.map {
      [
        "idempotencyKey": saved!.completionIntent.uuidString.lowercased(),
        "leaseId": $0.leaseID.uuidString.lowercased(), "leaseGeneration": $0.generation,
        "finalSequence": saved!.committedChunks - 1,
      ]
    }
    let signal: [String: Any]? = host.signal.map {
      [
        "inputBuffers": $0.inputBuffers, "convertedBuffers": $0.convertedBuffers,
        "inputEverNonzero": $0.inputEverNonzero, "convertedEverNonzero": $0.convertedEverNonzero,
        "inputLevel": $0.inputLevel, "convertedLevel": $0.convertedLevel,
        "inputAgeMs": $0.inputAgeMs as Any? ?? NSNull(),
        "convertedAgeMs": $0.convertedAgeMs as Any? ?? NSNull(),
        "zeroInputMs": $0.zeroInputMs, "route": $0.route.rawValue, "inputMuted": inputMuted,
      ]
    }
    return [
      "version": 1, "revision": version, "recorderId": entry.id.uuidString.lowercased(),
      "sessionId": host.scope.sessionID.uuidString.lowercased(), "phase": host.phase.rawValue,
      "failure": host.failure?.rawValue as Any? ?? NSNull(), "busy": host.busy,
      "recordedChunks": count, "recordedPlaintextBytes": bytes,
      "maximumPlaintextBytes": NativeRecordingFlowOwner.maximumPlaintextBytes,
      "input": host.microphoneInput.rawValue, "completion": completion as Any? ?? NSNull(),
      "signal": ["version": 2, "signal": signal as Any? ?? NSNull()],
    ]
  }
}
