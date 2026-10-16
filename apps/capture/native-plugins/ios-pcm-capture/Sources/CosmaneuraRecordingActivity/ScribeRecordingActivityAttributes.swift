#if os(iOS)
  import ActivityKit
  import Foundation

  /// Deliberately contains no patient, encounter, account or audio identifiers.
  public struct ScribeRecordingActivityAttributes: ActivityAttributes, Sendable {
    public struct ContentState: Codable, Hashable, Sendable {
      public let phase: String
      public let elapsedSeconds: Int
      public let timerAnchor: Date
      public init(phase: String, elapsedSeconds: Int, timerAnchor: Date) {
        self.phase = phase; self.elapsedSeconds = elapsedSeconds; self.timerAnchor = timerAnchor
      }
    }
    public init() {}
  }
#endif
