import Foundation

@MainActor public protocol NativePassagePlayer: AnyObject {
  var playing: Bool { get }
  var positionMs: Int { get }
  var durationMs: Int { get }
  func play() -> Bool
  func stop()
}

/// Owns native playback independently of renderer promises. Preparation includes
/// fresh authorization; cancellation fences a late response before audio starts.
@MainActor public final class NativePassagePlayback {
  public struct State: Sendable {
    public let playing: Bool, positionMs: Int, durationMs: Int
  }
  private var generation = UUID()
  private var pending: UUID?, active: UUID?, lastStopped: UUID?
  private var earlyStops = Set<UUID>()
  private var player: (any NativePassagePlayer)?
  private var preparation: Task<Data?, Error>?
  public init() {}
  public func stopAll() {
    generation = UUID()
    preparation?.cancel(); preparation = nil
    lastStopped = active ?? pending ?? lastStopped
    active = nil; pending = nil
    player?.stop(); player = nil
  }
  public func stop(requestID: UUID) throws {
    if requestID == active || requestID == pending { stopAll(); return }
    if requestID == lastStopped { return }
    // Stop may arrive before Capacitor schedules its matching start task.
    guard earlyStops.count < 128 else { throw NativeRecordingFailure.invalidPacket }
    earlyStops.insert(requestID)
  }
  public func play(requestID: UUID,
    current: @MainActor () throws -> Void,
    prepare: @escaping @MainActor () async throws -> Data?,
    makePlayer: @MainActor (Data) throws -> any NativePassagePlayer) async throws -> State? {
    try current();try Task.checkCancellation()
    guard requestID != lastStopped, earlyStops.remove(requestID) == nil else { throw CancellationError() }
    stopAll(); let ticket = generation; pending = requestID
    defer {
      if pending == requestID {
        pending = nil; preparation = nil
        if active != requestID { lastStopped = requestID }
      }
    }
    let preparing = Task { @MainActor in try await prepare() }
    preparation = preparing
    var wav = try await withTaskCancellationHandler {
      try await preparing.value
    } onCancel: { preparing.cancel() }
    defer { if wav != nil { wav!.resetBytes(in: 0..<wav!.count) } }
    try Task.checkCancellation();try current()
    guard generation == ticket, pending == requestID else { throw CancellationError() }
    guard let audio = wav else { return nil }
    guard (46...960_044).contains(audio.count) else { throw NativeRecordingFailure.invalidPacket }
    let next = try makePlayer(audio)
    do {
      try current();try Task.checkCancellation()
      guard generation == ticket, pending == requestID, (1...30_000).contains(next.durationMs), next.play() else {
        throw NativeRecordingFailure.invalidPacket
      }
    } catch { next.stop();throw error }
    player = next;active = requestID
    return state(requestID: requestID)
  }
  public func state(requestID: UUID) -> State? {
    if requestID == lastStopped { return State(playing: false, positionMs: 0, durationMs: 0) }
    guard requestID == active, let player else { return nil }
    let value = State(playing: player.playing, positionMs: max(0, min(player.positionMs, player.durationMs)), durationMs: player.durationMs)
    if !value.playing { stopAll() }
    return value
  }
}
