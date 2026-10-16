import ActivityKit
import CosmaneuraRecordingActivity
import SwiftUI
import WidgetKit

@main struct ScribeRecordingWidgetBundle: WidgetBundle {
  var body: some Widget { ScribeRecordingWidget() }
}

struct ScribeRecordingWidget: Widget {
  private let mint = Color(red: 0.49, green: 0.81, blue: 0.67)
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ScribeRecordingActivityAttributes.self) { context in
      HStack(spacing: 16) {
        Image(systemName: "waveform.circle.fill").font(.system(size: 38)).foregroundStyle(mint)
        VStack(alignment: .leading, spacing: 4) {
          Text("Scribe").font(.headline)
          Text(label(context)).font(.subheadline)
        }
        Spacer()
        timer(context).font(.system(size: 32, weight: .medium, design: .monospaced))
      }
      .padding(20)
      .activityBackgroundTint(Color(red: 0.06, green: 0.18, blue: 0.13))
      .activitySystemActionForegroundColor(.white)
      .foregroundStyle(.white)
      .widgetURL(URL(string: "scribe-recording://recording"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label("Scribe", systemImage: "waveform.circle.fill").foregroundStyle(mint)
        }
        DynamicIslandExpandedRegion(.trailing) { timer(context).monospacedDigit() }
        DynamicIslandExpandedRegion(.bottom) {
          Text(label(context)).font(.headline)
        }
      } compactLeading: {
        Image(systemName: context.state.phase == "paused" ? "pause.fill" : "waveform")
          .foregroundStyle(mint)
      } compactTrailing: {
        timer(context).font(.system(size: 15, weight: .medium, design: .monospaced)).frame(maxWidth: 74)
      } minimal: {
        Image(systemName: context.isStale ? "exclamationmark" : context.state.phase == "paused" ? "pause.fill" : "waveform").foregroundStyle(mint)
      }
      .widgetURL(URL(string: "scribe-recording://recording"))
      .keylineTint(mint)
    }
  }

  private func label(_ context: ActivityViewContext<ScribeRecordingActivityAttributes>) -> String {
    if context.isStale { return "Check Scribe" }
    switch context.state.phase {
    case "recording": return "Recording"
    case "paused": return "Paused — visit not finished"
    default: return "Stopping recording…"
    }
  }
  @ViewBuilder private func timer(_ context: ActivityViewContext<ScribeRecordingActivityAttributes>) -> some View {
    if context.state.phase == "recording", !context.isStale {
      Text(context.state.timerAnchor, style: .timer)
    } else {
      let seconds = context.state.elapsedSeconds
      Text(String(format: "%02d:%02d", seconds / 60, seconds % 60))
    }
  }
}
