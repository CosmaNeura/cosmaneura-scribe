import Foundation
import XCTest
@testable import CosmaneuraNativeRecording

@MainActor final class NativePassagePlaybackTests: XCTestCase {
  final class Player: NativePassagePlayer {
    var playing = false, positionMs = 0, durationMs = 1000, starts = 0, stops = 0
    var succeeds = true
    func play() -> Bool { starts += 1; playing = succeeds; return succeeds }
    func stop() { stops += 1; playing = false }
  }
  private func audio() -> Data { Data(repeating: 0, count: 46) }
  func testStopsOnlyOwnedPlayerAndReturnsBoundedMetadata() async throws {
    let owner = NativePassagePlayback(), player = Player(), id = UUID()
    let result = try await owner.play(requestID: id, current: {}, prepare: { self.audio() }, makePlayer: { _ in player })
    XCTAssertEqual(result?.playing, true); XCTAssertEqual(player.starts, 1)
    try owner.stop(requestID: UUID()); XCTAssertEqual(player.stops, 0)
    player.positionMs = 4000
    XCTAssertEqual(owner.state(requestID: id)?.positionMs, 1000)
    try owner.stop(requestID: id); XCTAssertEqual(player.stops, 1)
    XCTAssertEqual(owner.state(requestID: id)?.playing, false)
  }
  func testCancellationBeforeStartCannotPlay() async throws {
    let owner = NativePassagePlayback(), player = Player(), id = UUID()
    try owner.stop(requestID: id)
    do { _ = try await owner.play(requestID: id, current: {}, prepare: { self.audio() }, makePlayer: { _ in player }); XCTFail() }
    catch is CancellationError {} catch { XCTFail("Wrong cancellation") }
    XCTAssertEqual(player.starts, 0)
  }
  func testLateAuthorizationCannotPlayAfterStopOrAuthorityChange() async throws {
    for authChange in [false, true] {
      let owner = NativePassagePlayback(), player = Player(), id = UUID()
      var authorized = true, waiting: CheckedContinuation<Data?, Never>?
      let task = Task { @MainActor in
        try await owner.play(requestID: id, current: { if !authorized { throw CancellationError() } },
          prepare: { await withCheckedContinuation { waiting = $0 } }, makePlayer: { _ in player })
      }
      while waiting == nil { await Task.yield() }
      if authChange { authorized = false } else { owner.stopAll() }
      waiting?.resume(returning: audio())
      do { _ = try await task.value; XCTFail() } catch {}
      XCTAssertEqual(player.starts, 0)
    }
  }
  func testNewPlayStopsPreviousBeforeStartingAndNaturalEndReleases() async throws {
    let owner = NativePassagePlayback(), first = Player(), second = Player(), next = UUID()
    _ = try await owner.play(requestID: UUID(), current: {}, prepare: { self.audio() }, makePlayer: { _ in first })
    _ = try await owner.play(requestID: next, current: {}, prepare: { self.audio() }, makePlayer: { _ in
      XCTAssertEqual(first.stops, 1); return second
    })
    second.playing = false
    XCTAssertEqual(owner.state(requestID: next)?.playing, false); XCTAssertEqual(second.stops, 1)
  }
  func testNoPlayerForUnavailableArchiveOrOverlongData() async throws {
    let owner = NativePassagePlayback()
    let result = try await owner.play(requestID: UUID(), current: {}, prepare: { nil }, makePlayer: { _ in XCTFail();return Player() })
    XCTAssertNil(result)
    do { _ = try await owner.play(requestID: UUID(), current: {}, prepare: { Data(count: 960_045) }, makePlayer: { _ in XCTFail(); return Player() }); XCTFail() } catch {}
  }
  func testRejectsOverlongPlayerAndFailedStartWithoutLeavingAudio() async throws {
    for duration in [30_001, 1000] {
      let owner = NativePassagePlayback(), player = Player(); player.durationMs = duration; player.succeeds = false
      do { _ = try await owner.play(requestID: UUID(), current: {}, prepare: { self.audio() }, makePlayer: { _ in player }); XCTFail() } catch {}
      XCTAssertEqual(player.stops, 1); XCTAssertFalse(player.playing)
    }
  }
  func testRepeatedFailedPreparationDoesNotExhaustEarlyCancellationCustody() async throws {
    let owner = NativePassagePlayback()
    for _ in 0..<200 {
      let id = UUID()
      do { _ = try await owner.play(requestID: id, current: {}, prepare: { throw CancellationError() }, makePlayer: { _ in XCTFail();return Player() }); XCTFail() } catch {}
      try owner.stop(requestID: id)
    }
    let final = UUID();try owner.stop(requestID: final)
    do { _ = try await owner.play(requestID: final, current: {}, prepare: { self.audio() }, makePlayer: { _ in XCTFail();return Player() }); XCTFail() } catch {}
  }

}
