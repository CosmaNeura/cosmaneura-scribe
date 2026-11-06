#if os(iOS)
  @preconcurrency import AVFoundation
  import UIKit

  @MainActor public enum ScribeRecordingHaptic {
    private static var generation = UUID()

    /// iOS mutes haptics while a session records. Allow them only around this
    /// pulse so system sounds cannot reach the rest of the clinical recording.
    /// Feedback never affects capture, so a rejected session setting is ignored.
    public static func confirmListening() {
      let session = AVAudioSession.sharedInstance()
      try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
      let generator = UINotificationFeedbackGenerator()
      generator.notificationOccurred(.success)
      let ticket = UUID()
      generation = ticket
      Task { @MainActor in
        try? await Task.sleep(for: .seconds(1))
        guard generation == ticket else { return }
        try? session.setAllowHapticsAndSystemSoundsDuringRecording(false)
      }
    }
  }
#endif
