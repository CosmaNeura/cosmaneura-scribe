import Foundation

/// Same bounded, local lifecycle-only contract as the desktop runtime journal.
/// There is no string/message/identity/content input and no network transport.
public enum PCMStartupEvent: String, Codable, Sendable {
  case startRequested, ticketAccepted, permissionAccepted, authorityAccepted, handleCreated
  case leaseReady, reservationsReady, sourcePrepareRequested, sourcePrepared, sourceConsumeRequested
  case sourceReadyRequested, sourceReadyReceived
  case firstInputBuffer, firstInputSignal, firstConvertedBuffer, firstConvertedSignal
  case startRejected, readyRequested, readyAccepted, readyRejected
  case driverStarting, sessionActivated, tapInstalled, engineStarted, driverArmed, driverRejected
  case engineConfigurationChanged, sessionConfigurationChanged, routeChanged, interrupted
  case mediaServicesLost, mediaServicesReset, backgrounded, permissionRevoked, captureFailed
  case inputFrozen, driverReleased, stopRequested, stopAccepted, stopRejected
  case recordToNativeReady
}

public final class PCMStartupDiagnostics: @unchecked Sendable {
  public static let shared = PCMStartupDiagnostics()
  public static let maximumEvents = 128
  private struct Entry: Codable {
    let utc: Date; let event: PCMStartupEvent
    let durationMilliseconds: Double?; let buildNumber: Int?
    enum CodingKeys: String, CodingKey {
      case utc, event, durationMilliseconds = "duration_ms", buildNumber = "build_number"
    }
  }
  private let queue = DispatchQueue(label: "com.cosmaneura.scribe.capture-startup-diagnostics")
  private let admission = NSLock()
  private var admitted = 0
  private var destination: URL?
  private var entries: [Entry] = []

  public init() {}

  /// Called only by the native app, with a fixed path in its own Caches folder.
  /// Reconfiguration cannot reset the per-process bound or redirect an active journal.
  public func configure(destination: URL) {
    admission.withLock {
      guard self.destination == nil, destination.isFileURL else { return }
      self.destination = destination
    }
  }

  public func record(_ event: PCMStartupEvent) {
    guard event != .recordToNativeReady else { return }
    append(event, durationMilliseconds: nil, buildNumber: nil)
  }

  /// Only the native owner accepts this after confirmed recording. The renderer
  /// supplies a bounded same-process duration; the build comes from the app.
  public func recordReadyTiming(milliseconds: Double, buildNumber: Int? = nil) {
    guard milliseconds.isFinite, milliseconds >= 0, milliseconds <= 3_600_000 else { return }
    let candidate = buildNumber ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")
      as? String).flatMap(Int.init)
    let build = candidate.flatMap { (1...2_147_483_647).contains($0) ? $0 : nil }
    append(.recordToNativeReady, durationMilliseconds: (milliseconds * 1000).rounded() / 1000,
      buildNumber: build)
  }

  private func append(_ event: PCMStartupEvent, durationMilliseconds: Double?, buildNumber: Int?) {
    let target = admission.withLock { () -> URL? in
      guard let destination, admitted < Self.maximumEvents else { return nil }
      admitted += 1
      return destination
    }
    guard let target else { return }
    let entry = Entry(utc: Date(), event: event, durationMilliseconds: durationMilliseconds, buildNumber: buildNumber)
    queue.async { [self] in
      entries.append(entry)
      do {
        let encoder = JSONEncoder()
        // Milliseconds distinguish native setup from reservation/admission waits.
        // Lifecycle rows keep their two-field envelope. Only the Ready timing
        // has bounded numeric duration/build fields; no IDs or content enter it.
        encoder.dateEncodingStrategy = .custom { date, encoder in
          let formatter = ISO8601DateFormatter()
          formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
          var container = encoder.singleValueContainer()
          try container.encode(formatter.string(from: date))
        }
        let data = try encoder.encode(entries)
        guard data.count <= 32_768 else { return }
        try data.write(to: target, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        var url = target
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
      } catch { /* Diagnostic failure never changes capture or cleanup. */ }
    }
  }

  public func flush() async {
    await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
  }
}
