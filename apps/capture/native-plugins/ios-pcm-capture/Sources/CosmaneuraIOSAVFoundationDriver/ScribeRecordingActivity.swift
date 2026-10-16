#if os(iOS)
  @preconcurrency import ActivityKit
  import Foundation
  import CosmaneuraRecordingActivity

  @MainActor public enum ScribeRecordingActivity {
    private static var activity: Activity<ScribeRecordingActivityAttributes>?
    private static var generation = UUID()

    public static func update(phase: String, capturedAudioFrames: Int) {
      guard ["recording", "paused", "stopping"].contains(phase) else { return }
      let seconds = max(0, capturedAudioFrames / 16000)
      let state = ScribeRecordingActivityAttributes.ContentState(
        phase: phase, elapsedSeconds: seconds,
        timerAnchor: Date().addingTimeInterval(-Double(seconds)))
      // If native maintenance stops or dies, stale lock-screen content tells
      // the provider to check Scribe instead of claiming recording continues.
      let content = ActivityContent(state: state,
        staleDate: phase == "paused" ? nil : Date().addingTimeInterval(15))
      let ticket = UUID(); generation = ticket
      if activity == nil, phase == "recording", ActivityAuthorizationInfo().areActivitiesEnabled {
        // A previous process can leave stale UI, but cannot still own our native
        // graph. Close those indicators before publishing this verified run.
        for old in Activity<ScribeRecordingActivityAttributes>.activities {
          Task { await old.end(nil, dismissalPolicy: .immediate) }
        }
        activity = try? Activity.request(attributes: ScribeRecordingActivityAttributes(),
          content: content, pushType: nil)
      } else if let current = activity {
        Task { @MainActor in
          guard generation == ticket else { return }
          await current.update(content)
        }
      }
    }

    public static func end() {
      generation = UUID()
      let current = Activity<ScribeRecordingActivityAttributes>.activities
      activity = nil
      Task { for value in current { await value.end(nil, dismissalPolicy: .immediate) } }
    }
  }
#endif
