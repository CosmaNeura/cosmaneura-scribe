import Foundation

/// Ephemeral, content-free feedback. Never retains samples, device names or IDs.
/// Reading the meter cannot start, stop, acknowledge or otherwise affect capture.
public final class PCMSignalMonitor: @unchecked Sendable {
  public enum InputRoute: String, Sendable {
    case builtIn = "built_in", bluetooth, wired, usb, other, none
  }

  public struct Snapshot: Sendable {
    public let inputBuffers: Int
    public let convertedBuffers: Int
    public let inputEverNonzero: Bool
    public let convertedEverNonzero: Bool
    public let inputLevel: Double
    public let convertedLevel: Double
    public let inputAgeMs: Int?
    public let convertedAgeMs: Int?
    public let zeroInputMs: Int
    public let route: InputRoute
  }

  private struct Reading {
    var buffers = 0
    var everNonzero = false
    var level = 0.0
    var time: UInt64?
  }
  private let lock = NSLock()
  private let now: @Sendable () -> UInt64
  private let diagnostics: PCMStartupDiagnostics
  private var input = Reading()
  private var converted = Reading()
  private var zeroInputMilliseconds = 0.0
  private var route: InputRoute = .none

  public init(
    diagnostics: PCMStartupDiagnostics = .shared,
    now: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }
  ) {
    self.diagnostics = diagnostics
    self.now = now
  }

  public func reset() {
    lock.withLock {
      input = Reading(); converted = Reading(); zeroInputMilliseconds = 0; route = .none
    }
  }

  public func setRoute(_ route: InputRoute) { lock.withLock { self.route = route } }

  /// Called on the native tap's owned copy, before asynchronous sample delivery.
  public func recordInput(_ channels: [[Float]], sampleRateHz: Int) {
    guard sampleRateHz > 0, let frames = channels.first?.count, frames > 0 else { return }
    var sum = 0.0, count = 0
    var nonzero = false
    for channel in channels {
      for sample in channel where sample.isFinite {
        let value = min(1, max(-1, Double(sample)))
        nonzero = nonzero || value != 0
        sum += value * value; count += 1
      }
    }
    guard count > 0 else { return }
    let level = sqrt(sum / Double(count)), time = now()
    let first = lock.withLock {
      let first = (input.buffers == 0, nonzero && !input.everNonzero)
      input.buffers += 1; input.everNonzero = input.everNonzero || nonzero
      input.level = level; input.time = time
      zeroInputMilliseconds = nonzero ? 0
        : min(86_400_000, zeroInputMilliseconds + Double(frames) * 1_000 / Double(sampleRateHz))
      return first
    }
    // At most two fixed events per boundary/interval, asynchronously persisted.
    // No samples, levels or continuous speech-activity timeline are retained.
    if first.0 { diagnostics.record(.firstInputBuffer) }
    if first.1 { diagnostics.record(.firstInputSignal) }
  }

  /// Called after downmix/resampling, before accumulation, encoding or clearing.
  public func recordConverted(_ samples: [Int16]) {
    guard !samples.isEmpty else { return }
    var sum = 0.0, nonzero = false
    for sample in samples {
      let value = Double(sample) / 32_768
      sum += value * value; nonzero = nonzero || sample != 0
    }
    let level = sqrt(sum / Double(samples.count)), time = now()
    let first = lock.withLock {
      let first = (converted.buffers == 0, nonzero && !converted.everNonzero)
      converted.buffers += 1; converted.everNonzero = converted.everNonzero || nonzero
      converted.level = level; converted.time = time
      return first
    }
    if first.0 { diagnostics.record(.firstConvertedBuffer) }
    if first.1 { diagnostics.record(.firstConvertedSignal) }
  }

  public func snapshot() -> Snapshot {
    let time = now()
    return lock.withLock {
      func age(_ reading: Reading) -> Int? {
        reading.time.map { Int(min(86_400_000, (time >= $0 ? time - $0 : 0) / 1_000_000)) }
      }
      return Snapshot(inputBuffers: input.buffers, convertedBuffers: converted.buffers,
        inputEverNonzero: input.everNonzero, convertedEverNonzero: converted.everNonzero,
        inputLevel: input.level, convertedLevel: converted.level,
        inputAgeMs: age(input), convertedAgeMs: age(converted),
        zeroInputMs: Int(zeroInputMilliseconds), route: route)
    }
  }
}
