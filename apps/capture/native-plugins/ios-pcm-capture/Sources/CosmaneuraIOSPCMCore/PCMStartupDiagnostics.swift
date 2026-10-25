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
  public static let maximumPending = 160
  private struct Entry: Encodable {
    let utc: Date; let event: PCMStartupEvent; let clock = "dispatch-uptime-ns"
    let monotonicNanoseconds: String; let captureAttempt: Int; let droppedEvents: Int
    let durationMilliseconds: Double?; let buildNumber: Int?
    enum CodingKeys: String, CodingKey {
      case utc, event, clock, monotonicNanoseconds = "monotonic_ns", captureAttempt = "capture_attempt"
      case droppedEvents = "dropped_events", durationMilliseconds = "duration_ms", buildNumber = "build_number"
    }
  }
  private let queue: DispatchQueue
  private let monotonicNow: @Sendable () -> UInt64
  private let wallNow: @Sendable () -> Date
  private let admission = NSLock()
  private var remaining = 128, remainingTerminal = 32, pending = 0, attempt = 0, dropped = 0
  private var destination: URL?
  private var entries: [Entry] = []

  public init(monotonicNow: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
    wallNow: @escaping @Sendable () -> Date = { Date() },
    queue: DispatchQueue = DispatchQueue(label: "com.cosmaneura.scribe.capture-startup-diagnostics")) {
    self.monotonicNow = monotonicNow; self.wallNow = wallNow; self.queue = queue
  }

  /// A read-only clock sample in the existing recorder reply. It consumes no
  /// event allowance and does not grant capture authority or create a request.
  public func timingSnapshot() -> [String: Any] {
    admission.withLock {
      ["version": 1, "clock": "dispatch-uptime-ns", "monotonicNs": String(monotonicNow()),
        "captureAttempt": attempt, "droppedEvents": dropped]
    }
  }

  /// Only the native app configures its fixed local destination, once.
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

  /// The native owner accepts this only after confirmed recording. This duration
  /// remains a renderer monotonic interval, distinct from the native event clock.
  public func recordReadyTiming(milliseconds: Double, buildNumber: Int? = nil) {
    guard milliseconds.isFinite, milliseconds >= 0, milliseconds <= 3_600_000 else { return }
    let candidate = buildNumber ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")
      as? String).flatMap(Int.init)
    let build = candidate.flatMap { (1...2_147_483_647).contains($0) ? $0 : nil }
    append(.recordToNativeReady, durationMilliseconds: (milliseconds * 1000).rounded() / 1000,
      buildNumber: build)
  }

  private func append(_ event: PCMStartupEvent, durationMilliseconds: Double?, buildNumber: Int?) {
    admission.withLock {
      guard let target = destination else { return }
      // Reset before the pending-queue guard: a saturated earlier attempt must
      // not permanently suppress the next attempt's evidence after writes settle.
      if event == .startRequested {
        remaining = 128; remainingTerminal = 32; attempt = min(2_147_483_647, attempt + 1); dropped = 0
      }
      let terminal: Bool
      switch event {
      case .startRejected, .readyRejected, .driverRejected, .interrupted, .routeChanged,
        .mediaServicesLost, .mediaServicesReset, .backgrounded, .permissionRevoked, .captureFailed,
        .inputFrozen, .driverReleased, .stopRequested, .stopAccepted, .stopRejected: terminal = true
      default: terminal = false
      }
      guard pending < Self.maximumPending, terminal ? remainingTerminal > 0 : remaining > 0 else {
        dropped = min(2_147_483_647, dropped + 1); return
      }
      if terminal { remainingTerminal -= 1 } else { remaining -= 1 }
      pending += 1
      let entry = Entry(utc: wallNow(), event: event, monotonicNanoseconds: String(monotonicNow()),
        captureAttempt: attempt, droppedEvents: dropped,
        durationMilliseconds: durationMilliseconds, buildNumber: buildNumber)
      // Enqueue under the admission lock to preserve monotonic admission order
      // when native lifecycle and callback threads report concurrently.
      queue.async { [self] in
        defer { admission.withLock { pending -= 1 } }
        entries.append(entry)
        if entries.count > Self.maximumEvents { entries.removeFirst(entries.count - Self.maximumEvents) }
        do {
          let encoder = JSONEncoder()
          encoder.dateEncodingStrategy = .custom { date, encoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: date))
          }
          var data = try encoder.encode(entries)
          while data.count > 32_768 && entries.count > 1 {
            entries.removeFirst(); data = try encoder.encode(entries)
          }
          guard data.count <= 32_768 else { return }
          try data.write(to: target, options: .atomic)
          try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
          var url = target
          var values = URLResourceValues(); values.isExcludedFromBackup = true
          try url.setResourceValues(values)
        } catch { /* Diagnostic failure never changes capture or cleanup. */ }
      }
    }
  }

  public func flush() async {
    await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
  }
}
