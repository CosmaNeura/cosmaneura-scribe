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
        observedUID == selectedUID && observedFormat == format && (starting || engineRunning)
    }
}
