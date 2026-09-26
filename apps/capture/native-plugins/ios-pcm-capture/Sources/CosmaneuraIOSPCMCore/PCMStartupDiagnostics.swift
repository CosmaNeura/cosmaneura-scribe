import Foundation

/// Same bounded, local lifecycle-only contract as the desktop runtime journal.
/// There is no string/message/identity/content input and no network transport.
public enum PCMStartupEvent: String, Codable, Sendable {
  case startRequested, ticketAccepted, permissionAccepted, authorityAccepted, handleCreated
  case startRejected, readyRequested, readyAccepted, readyRejected
  case driverStarting, sessionActivated, tapInstalled, engineStarted, driverArmed, driverRejected
  case engineConfigurationChanged, sessionConfigurationChanged, routeChanged, interrupted
  case mediaServicesLost, mediaServicesReset, backgrounded, permissionRevoked, captureFailed
  case inputFrozen, driverReleased, stopRequested, stopAccepted, stopRejected
}

public final class PCMStartupDiagnostics: @unchecked Sendable {
  public static let shared = PCMStartupDiagnostics()
  public static let maximumEvents = 128
  private struct Entry: Codable { let utc: Date; let event: PCMStartupEvent }
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
    let target = admission.withLock { () -> URL? in
      guard let destination, admitted < Self.maximumEvents else { return nil }
      admitted += 1
      return destination
    }
    guard let target else { return }
    let entry = Entry(utc: Date(), event: event)
    queue.async { [self] in
      entries.append(entry)
      do {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
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
