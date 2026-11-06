#if os(iOS)
  import UIKit

  @MainActor public enum ScribeRecordingHaptic {
    public static func confirmListening() {
      UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
  }
#endif
