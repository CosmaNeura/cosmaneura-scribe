import CosmaneuraNativeRecording
import Foundation

// Matched synthetic transport delays around the actual native Host. The source,
// account and network are test doubles. This is not a physical-iPhone timing.
private actor DelayedLegacy: NativeProviderRecordingHost.Service {
  let service: CheckNativeRecordingHost.Service
  let delay: Int
  var operations: [String] = []
  init(_ service: CheckNativeRecordingHost.Service, delay: Int) {
    self.service = service
    self.delay = delay
  }
  func request(_ name: String) async throws {
    operations.append(name)
    try await Task.sleep(for: .milliseconds(delay))
  }
  func recordingScope() async throws -> NativeRecordingScope { try await service.recordingScope() }
  func publishedKey() async throws -> NativeRecordingPublicKey {
    try await request("key")
    return try await service.publishedKey()
  }
  func bind(key: NativeRecordingKeyReceipt, intent: UUID) async throws
    -> NativeRecordingBindingAcknowledgement
  {
    try await request("bind")
    return try await service.bind(key: key, intent: intent)
  }
  func requestLease(previous: NativeRecordingLease?, intent: UUID) async throws
    -> NativeRecordingLease
  {
    try await request(previous == nil ? "issue" : "renew")
    return try await service.requestLease(previous: previous, intent: intent)
  }
  func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) async throws
    -> NativeRecordingReservationBatch
  {
    try await request("reserve")
    return try await service.reserve(lease: lease, first: first, count: count, intent: intent)
  }
}
private actor DelayedAggregate: NativeProviderRecordingHost.Service, NativeRecordingWindowService,
  NativeRecordingResumeWindowService
{
  let service: CheckNativeRecordingHost.Service
  let delay: Int
  var operations: [String] = []
  var initial: [UUID: NativeRecordingWindowReceipt] = [:]
  var resumed: [UUID: NativeRecordingResumeWindowReceipt] = [:]
  init(_ service: CheckNativeRecordingHost.Service, delay: Int) {
    self.service = service
    self.delay = delay
  }
  func request(_ name: String) async throws {
    operations.append(name)
    try await Task.sleep(for: .milliseconds(delay))
  }
  func recordingScope() async throws -> NativeRecordingScope { try await service.recordingScope() }
  func publishedKey() async throws -> NativeRecordingPublicKey {
    try await request("key")
    return try await service.publishedKey()
  }
  func bind(key: NativeRecordingKeyReceipt, intent: UUID) async throws
    -> NativeRecordingBindingAcknowledgement
  {
    try await request("legacy-bind")
    return try await service.bind(key: key, intent: intent)
  }
  func requestLease(previous: NativeRecordingLease?, intent: UUID) async throws
    -> NativeRecordingLease
  {
    try await request(previous == nil ? "legacy-issue" : "legacy-renew")
    return try await service.requestLease(previous: previous, intent: intent)
  }
  func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) async throws
    -> NativeRecordingReservationBatch
  {
    try await request("legacy-reserve")
    return try await service.reserve(lease: lease, first: first, count: count, intent: intent)
  }
  func prepareInitialWindow(_ request: NativeRecordingWindowRequest) async throws
    -> NativeRecordingWindowReceipt
  {
    try await self.request("initial-window")
    if let result = initial[request.bindIntent] { return result }
    let binding = try await service.bind(key: request.binding, intent: request.bindIntent)
    let lease = try await service.requestLease(previous: nil, intent: request.leaseIntent)
    let batch = try await service.reserve(
      lease: lease, first: 0, count: request.count, intent: request.reserveIntent)
    let result = NativeRecordingWindowReceipt(
      sessionID: binding.sessionID, keyVersion: binding.keyVersion, lease: lease, batch: batch)
    initial[request.bindIntent] = result
    return result
  }
  func prepareResumeWindow(_ request: NativeRecordingResumeWindowRequest) async throws
    -> NativeRecordingResumeWindowReceipt
  {
    try await self.request("resume-window")
    if let result = resumed[request.intent] { return result }
    let lease = try await service.requestLease(
      previous: request.previous, intent: request.renewIntent)
    let batch = try await service.reserve(
      lease: lease, first: request.first, count: min(30, 2048 - request.first),
      intent: request.reserveIntent)
    let result = NativeRecordingResumeWindowReceipt(lease: lease, batch: batch)
    resumed[request.intent] = result
    return result
  }
}

@main struct WindowTiming {
  @MainActor static func main() async throws {
    func ms(_ start: ContinuousClock.Instant) -> Double {
      let d = start.duration(to: .now).components
      return Double(d.seconds) * 1000 + Double(d.attoseconds) / 1e15
    }
    var results: [[String: Any]] = []
    for delay in [650, 1800] {
      for aggregate in [false, true] {
        let f = try CheckNativeRecordingHost.Fixture()
        var now = Date()
        let legacy = DelayedLegacy(f.service, delay: delay)
        let combined = DelayedAggregate(f.service, delay: delay)
        let service: any NativeProviderRecordingHost.Service = aggregate ? combined : legacy
        let host = f.host(service: service, now: { now })
        let cold = ContinuousClock.now
        try await host.open()
        let openMs = ms(cold)
        try await host.start()
        try f.runs.last!.emit()
        try CheckNativeRecordingHost.check(host.phase == .recording)
        let coldMs = ms(cold)
        let firstOps = aggregate ? await combined.operations : await legacy.operations
        let key = f.keys.value
        // The same recorded visit now pauses near lease expiry. Resume renews
        // authority and reservations; no source grant is reused.
        now = now.addingTimeInterval(850)
        await f.service.configure(now: now)
        let resume = ContinuousClock.now
        try await host.pause()
        try await host.start()
        try f.runs.last!.emit()
        let resumeMs = ms(resume)
        try CheckNativeRecordingHost.check(
          host.phase == .recording && f.runs.count == 2 && f.keys.value == key)
        let allOps = aggregate ? await combined.operations : await legacy.operations
        let quick = ContinuousClock.now
        try await host.pause()
        try await host.start()
        try f.runs.last!.emit()
        let quickMs = ms(quick)
        let finalOps = aggregate ? await combined.operations : await legacy.operations
        try CheckNativeRecordingHost.check(finalOps == allOps && f.runs.count == 3)
        results.append([
          "aggregate": aggregate, "injectedRoundTripMs": delay,
          "coldOpenMs": openMs, "coldOpenThroughFirstSyntheticPacketMs": coldMs,
          "expiredResumeThroughFirstSyntheticPacketMs": resumeMs, "healthyResumeMs": quickMs,
          "coldOperations": firstOps,
          "expiredResumeOperations": Array(allOps.dropFirst(firstOps.count)),
          "sameEncryptionKeyRetained": f.keys.value == key, "sourceIntervals": f.runs.count,
        ])
        try await host.close()
      }
    }
    print(
      String(
        decoding: try JSONSerialization.data(
          withJSONObject: [
            "runtime": "actual native Host, optimized macOS Swift 6", "physicalIOS": false,
            "microphone": false, "network": false, "sameSourcesCompared": true,
            "limitation":
              "Injected transport RTT; synthetic source and consent fixture. Actual iPhone permission, source-admission network and microphone startup are not measured.",
            "results": results,
          ], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
  }
}
