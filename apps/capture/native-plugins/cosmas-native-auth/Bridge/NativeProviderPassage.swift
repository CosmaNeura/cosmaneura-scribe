import Foundation
import CosmaneuraNativeRecording
#if os(iOS)
import AVFAudio
import CosmaneuraSecureQueue
#endif

#if os(iOS)
@MainActor final class LiveNativePassagePlayer: NativePassagePlayer {
  private let player: AVAudioPlayer
  init(_ data: Data) throws { player = try AVAudioPlayer(data: data) }
  var playing: Bool { player.isPlaying }
  var positionMs: Int { Int(player.currentTime * 1000) }
  var durationMs: Int { Int((player.duration * 1000).rounded()) }
  func play() -> Bool {
    do {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
      try AVAudioSession.sharedInstance().setActive(true)
      return player.play()
    } catch { return false }
  }
  func stop() { player.stop();try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
}

extension NativeProviderConnection {
  func passageAudio(_ s: NativeProviderPassageSelection, current: () throws -> Void) async throws -> Data? {
    try current()
    let mount = try recordingMount(workspaceID: s.workspaceID, bindingRef: s.bindingRef, revision: s.revision)
    let account = try passageAccountDigest(revision: s.revision)
    let nonce = UUID().uuidString.lowercased()
    let body = try JSONSerialization.data(withJSONObject: ["workspace_id": s.workspaceID.uuidString.lowercased(),
      "binding_ref": s.bindingRef, "request_nonce": nonce, "operation": ["kind": "creator_review"]])
    let request = try ProviderNativeRequest(id: s.requestID.uuidString.lowercased(), revision: s.revision,
      action: "capture-operations", key: UUID().uuidString.lowercased(), body: String(decoding: body, as: UTF8.self))
    let reply = try await send(request)
    try current();try Task.checkCancellation()
    guard try recordingMount(workspaceID: s.workspaceID, bindingRef: s.bindingRef, revision: s.revision) == mount,
      try passageAccountDigest(revision: s.revision) == account else { throw ProviderNativeError.authorityChanged }
    guard let range = try s.range(reply: reply, nonce: nonce) else { return nil }
    let recovery = mount.recoveryScope, workspace = s.workspaceID, session = s.sessionID
    let result = try await nativePassageWork {
      let records = try NativeRecordingQueueStore()
      guard let archive = try NativeRecordingPassageArchive.open(account: account, recovery: recovery,
        workspace: workspace, session: session, records: records) else { return nil as Data? }
      return try archive.audio(startMs: range.0, endMs: range.1, current: { try Task.checkCancellation() })
    }
    try current(); try Task.checkCancellation()
    guard try recordingMount(workspaceID: s.workspaceID, bindingRef: s.bindingRef, revision: s.revision) == mount,
      try passageAccountDigest(revision: s.revision) == account else { throw ProviderNativeError.authorityChanged }
    try NativeProviderPassageSelection.requireFresh(range.2)
    return result
  }
}
#endif
