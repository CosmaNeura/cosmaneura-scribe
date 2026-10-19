import XCTest
@testable import ScribeDesktopAudio

final class MicrophoneConfigurationTests: XCTestCase {
    private let format = MicrophoneCaptureFormat(sampleRate: 48_000, channelCount: 1, float32: true, interleaved: false)

    func testStartupNotificationsDoNotTurnAnUnchangedSelectedInputIntoDeviceLoss() {
        let configured = MicrophoneConfiguration(selectedUID: "invented-selected-input", format: format)
        // HAL may notify before the engine starts, or queue several notices
        // until after it starts. There is no first-event or timer exemption.
        for _ in 0..<8 {
            XCTAssertTrue(configured.permits(observedUID: "invented-selected-input", observedFormat: format,
                engineRunning: false, starting: true))
            XCTAssertTrue(configured.permits(observedUID: "invented-selected-input", observedFormat: format,
                engineRunning: true, starting: false))
        }
    }

    func testStartupMustNotAcceptAChangedOrDisappearedDevice() {
        let configured = MicrophoneConfiguration(selectedUID: "invented-selected-input", format: format)
        for starting in [true, false] {
            XCTAssertFalse(configured.permits(observedUID: "invented-other-input", observedFormat: format,
                engineRunning: true, starting: starting))
            XCTAssertFalse(configured.permits(observedUID: nil, observedFormat: format,
                engineRunning: true, starting: starting))
        }
    }

    func testAnyFormatChangeStopsEvenWithTheSameDeviceAndRunningEngine() {
        let configured = MicrophoneConfiguration(selectedUID: "invented-selected-input", format: format)
        let changed = [
            MicrophoneCaptureFormat(sampleRate: 44_100, channelCount: 1, float32: true, interleaved: false),
            MicrophoneCaptureFormat(sampleRate: 48_000, channelCount: 2, float32: true, interleaved: false),
            MicrophoneCaptureFormat(sampleRate: 48_000, channelCount: 1, float32: false, interleaved: false),
            MicrophoneCaptureFormat(sampleRate: 48_000, channelCount: 1, float32: true, interleaved: true),
        ]
        for starting in [true, false] {
            for observed in changed {
                XCTAssertFalse(configured.permits(observedUID: "invented-selected-input", observedFormat: observed,
                    engineRunning: true, starting: starting))
            }
            XCTAssertFalse(configured.permits(observedUID: "invented-selected-input", observedFormat: nil,
                engineRunning: true, starting: starting))
        }
    }

    func testStoppedRecordingEngineFailsEvenWhenDeviceAndFormatDidNotChange() {
        let configured = MicrophoneConfiguration(selectedUID: "invented-selected-input", format: format)
        XCTAssertFalse(configured.permits(observedUID: "invented-selected-input", observedFormat: format,
            engineRunning: false, starting: false))
    }

    func testMismatchBitsDistinguishEachExistingGateAndCombineChanges() {
        let configured = MicrophoneConfiguration(selectedUID: "invented-selected-input", format: format)
        XCTAssertEqual(configured.mismatch(observedUID: nil, observedFormat: format,
            engineRunning: true, starting: false), 2)
        XCTAssertEqual(configured.mismatch(observedUID: "invented-other-input", observedFormat: format,
            engineRunning: true, starting: false), 4)
        let changed: [(MicrophoneCaptureFormat, UInt8)] = [
            (.init(sampleRate: 44_100, channelCount: 1, float32: true, interleaved: false), 8),
            (.init(sampleRate: 48_000, channelCount: 2, float32: true, interleaved: false), 16),
            (.init(sampleRate: 48_000, channelCount: 1, float32: false, interleaved: false), 32),
            (.init(sampleRate: 48_000, channelCount: 1, float32: true, interleaved: true), 64)
        ]
        for (observed, bit) in changed {
            XCTAssertEqual(configured.mismatch(observedUID: "invented-selected-input", observedFormat: observed,
                engineRunning: true, starting: false), bit)
        }
        XCTAssertEqual(configured.mismatch(observedUID: "invented-selected-input", observedFormat: format,
            engineRunning: false, starting: false), 128)
        XCTAssertEqual(configured.mismatch(observedUID: "invented-selected-input", observedFormat: format,
            engineRunning: false, starting: true), 0)
        XCTAssertEqual(configured.mismatch(observedUID: "invented-other-input",
            observedFormat: .init(sampleRate: 44_100, channelCount: 2, float32: false, interleaved: true),
            engineRunning: false, starting: false), 252)
    }
}
