import Foundation
import Testing
@testable import ScribeDesktopAudio

private struct WindowFixture {
    let runID = UUID().uuidString.lowercased()
    let origin = ContinuousClock.now
    let epoch: Int64 = 1_000_000
    let hardFrames = 10_800 * 16_000
    func time(_ milliseconds: Int64, wall: Int64? = nil) -> DesktopCaptureTime {
        DesktopCaptureTime(epochMilliseconds: epoch + (wall ?? milliseconds), monotonic: origin.advanced(by: .milliseconds(milliseconds)))
    }
    func authorization(_ generation: Int = 1, expiry: Int64 = 900_000, frames: Int = 900 * 16_000,
                       run: String? = nil, hard: Int? = nil) throws -> DesktopCaptureAuthorization {
        try DesktopCaptureAuthorization(runID: run ?? runID, generation: generation, expiresAtMilliseconds: epoch + expiry,
            maximumOutputFrames: frames, hardMaximumOutputFrames: hard ?? hardFrames)
    }
}

@Test func threeHourDesktopWindowAdvancesWithoutResettingOriginalBudget() throws {
    let f = WindowFixture()
    var window = try DesktopCaptureWindow(f.authorization(), now: f.time(0))
    for generation in 2...14 {
        let elapsed = Int64(generation - 1) * 780_000
        let frames = min(f.hardFrames, Int(elapsed + 900_000) * 16)
        try window.extend(f.authorization(generation, expiry: elapsed + 900_000, frames: frames), now: f.time(elapsed))
        #expect(window.remaining(f.time(elapsed)) == .seconds(900))
        #expect(window.authorization.runID == f.runID && window.authorization.hardMaximumOutputFrames == f.hardFrames)
    }
    #expect(window.authorization.maximumOutputFrames == f.hardFrames)
    #expect(window.remaining(f.time(10_800_000)) > .zero)
}

@Test func duplicateDesktopExtensionCannotRefreshMonotonicDeadline() throws {
    let f = WindowFixture(), initial = try f.authorization()
    var window = try DesktopCaptureWindow(initial, now: f.time(0))
    try window.extend(initial, now: f.time(300_000, wall: 0))
    #expect(window.remaining(f.time(300_000, wall: 0)) == .seconds(600))
    #expect(window.remaining(f.time(900_000, wall: 0)) == .zero)
    #expect(throws: DesktopAudioFailure.self) { try window.extend(f.authorization(2, expiry: 1_000_000), now: f.time(900_000, wall: 0)) }
}

@Test func desktopWindowRejectsSubstitutionSkippingShrinkingAndExpiredResurrection() throws {
    let f = WindowFixture(), initial = try f.authorization()
    let invalid = [
        try f.authorization(2, expiry: 1_200_000, run: UUID().uuidString.lowercased()),
        try f.authorization(2, expiry: 1_200_000, hard: f.hardFrames + 1),
        try f.authorization(3, expiry: 1_200_000),
        try f.authorization(2, expiry: 899_999),
        try f.authorization(2, expiry: 1_200_000, frames: 1),
        try f.authorization(2, expiry: 1_200_000, frames: initial.maximumOutputFrames + 905 * 16_000 + 1),
        try f.authorization(2, expiry: 1_205_001),
    ]
    for value in invalid {
        var window = try DesktopCaptureWindow(initial, now: f.time(0))
        #expect(throws: DesktopAudioFailure.self) { try window.extend(value, now: f.time(300_000)) }
        #expect(window.authorization == initial)
    }
    for time in [f.time(900_000), f.time(1, wall: 900_000)] {
        var window = try DesktopCaptureWindow(initial, now: f.time(0))
        #expect(window.remaining(time) == .zero)
        #expect(throws: DesktopAudioFailure.self) { try window.extend(f.authorization(2, expiry: 1_200_000), now: time) }
    }
}

@Test func desktopWindowRejectsUnboundedOrAlreadyExpiredStarts() throws {
    let f = WindowFixture()
    for value in [try f.authorization(2), try f.authorization(expiry: 0), try f.authorization(expiry: 905_001),
                  try f.authorization(frames: 906 * 16_000)] {
        #expect(throws: DesktopAudioFailure.self) { try DesktopCaptureWindow(value, now: f.time(0)) }
    }
    #expect(throws: DesktopAudioFailure.self) { try f.authorization(frames: f.hardFrames + 1) }
}

@Test func stoppedOrDisabledPhysicalSourceCannotAcceptRenewal() async throws {
    let f = WindowFixture(), source = MacMeetingAudio()
    await #expect(throws: DesktopAudioFailure.self) { try await source.extend(f.authorization()) }
    try await source.stop()
    await #expect(throws: DesktopAudioFailure.self) { try await source.extend(f.authorization(2, expiry: 1_200_000)) }
}
