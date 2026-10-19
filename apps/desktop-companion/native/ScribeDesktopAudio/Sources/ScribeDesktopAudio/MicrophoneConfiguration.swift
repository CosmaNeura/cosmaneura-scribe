import Foundation

/// A notification is advisory; actual hardware/format and engine state decide
/// whether the explicitly authorized microphone is still the same source.
struct MicrophoneCaptureFormat: Sendable, Equatable {
    let sampleRate: Double
    let channelCount: UInt32
    let float32: Bool
    let interleaved: Bool
}

struct MicrophoneConfiguration: Sendable {
    let selectedUID: String
    let format: MicrophoneCaptureFormat

    func permits(observedUID: String?, observedFormat: MicrophoneCaptureFormat?,
                 engineRunning: Bool, starting: Bool) -> Bool {
        mismatch(observedUID: observedUID, observedFormat: observedFormat,
            engineRunning: engineRunning, starting: starting) == 0
    }

    /// Fixed mismatch bits preserve the exact same device/format/running gate.
    /// Values themselves stay in this native boundary and never enter metadata.
    func mismatch(observedUID: String?, observedFormat: MicrophoneCaptureFormat?,
                  engineRunning: Bool, starting: Bool) -> UInt8 {
        guard let observedUID else { return 2 }
        var result: UInt8 = observedUID == selectedUID ? 0 : 4
        if let observedFormat {
            if observedFormat.sampleRate != format.sampleRate { result |= 8 }
            if observedFormat.channelCount != format.channelCount { result |= 16 }
            if observedFormat.float32 != format.float32 { result |= 32 }
            if observedFormat.interleaved != format.interleaved { result |= 64 }
        } else { result |= 8 | 16 | 32 | 64 }
        if !starting && !engineRunning { result |= 128 }
        return result
    }
}
