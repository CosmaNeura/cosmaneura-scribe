import Foundation

/// AVAudioSession can announce a route change while our synchronous activation
/// and preferred-input selection are still in progress. No frames are admitted
/// then. The live adapter must verify the selected input when configuration ends.
final class AppleInputRouteEvents: @unchecked Sendable {
  private let lock = NSLock()
  private var configuring = false

  func withInputConfiguration(_ operation: () throws -> Void) rethrows {
    lock.withLock { configuring = true }
    defer { lock.withLock { configuring = false } }
    try operation()
  }

  func routeChange(knownConfiguration: Bool) -> AppleAudioSystemEvent {
    lock.withLock {
      configuring || knownConfiguration ? .configurationChanged : .routeChanged
    }
  }
}
