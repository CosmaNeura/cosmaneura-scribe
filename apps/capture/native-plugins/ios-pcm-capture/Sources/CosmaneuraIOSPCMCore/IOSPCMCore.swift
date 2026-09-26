import Foundation

public final class IOSPCMCore: @unchecked Sendable {
  private struct Active {
    let sessionID: UInt64
    var closeFailed: Bool
    var state: IOSPCMSessionState?
  }

  private let lock = NSLock()
  private let permission: any MicrophonePermissionAuthorizing
  private let audio: any PCMAudioDriving
  private let sink: any PCMEmissionSink
  private let clock: any PCMClock
  private let sourceClock: any PCMSourceClock
  private let signalMonitor: PCMSignalMonitor?
  private var usedRunIDs: Set<String> = []
  private var nextSessionID: UInt64 = 0
  private var active: Active?

  public init(
    permission: any MicrophonePermissionAuthorizing,
    audio: any PCMAudioDriving,
    sink: any PCMEmissionSink,
    clock: any PCMClock = ContinuousPCMClock(),
    sourceClock: any PCMSourceClock = ContinuousPCMSourceClock(),
    signalMonitor: PCMSignalMonitor? = nil
  ) {
    self.permission = permission
    self.audio = audio
    self.sink = sink
    self.clock = clock
    self.sourceClock = sourceClock
    self.signalMonitor = signalMonitor
  }

  /// Claims ownership synchronously and returns a handle before permission or
  /// audio readiness can wait.
  public func start(configuration: PCMConfiguration) throws -> IOSPCMSessionHandle {
    let window = try configuration.authority.map {
      try PCMSourceWindow(
        authority: $0, maximumChunks: configuration.maximumChunks,
        now: sourceClock.now())
    }
    let sessionID: UInt64 = try lock.withLock {
      if let active {
        throw PCMFailure(active.closeFailed ? .stopFailed : .alreadyActive)
      }
      guard nextSessionID < UInt64.max else { throw PCMFailure(.invalidConfiguration) }
      if let runID = window?.authority.runID {
        guard usedRunIDs.insert(runID).inserted else { throw PCMFailure(.invalidConfiguration) }
      }
      nextSessionID += 1
      active = Active(sessionID: nextSessionID, closeFailed: false, state: nil)
      return nextSessionID
    }
    let state = IOSPCMSessionState(
      sessionID: sessionID,
      configuration: configuration,
      permission: permission,
      audio: audio,
      sink: sink,
      clock: clock,
      sourceClock: sourceClock,
      signalMonitor: signalMonitor,
      window: window,
      markCloseFailed: { [weak self] in self?.markCloseFailed(sessionID) },
      releaseOwnership: { [weak self] in self?.release(sessionID) }
    )
    lock.withLock {
      guard active?.sessionID == sessionID else { return }
      active?.state = state
    }
    return IOSPCMSessionHandle(state: state)
  }

  private func markCloseFailed(_ sessionID: UInt64) {
    lock.withLock {
      guard active?.sessionID == sessionID else { return }
      active?.closeFailed = true
    }
  }

  private func release(_ sessionID: UInt64) {
    lock.withLock {
      guard active?.sessionID == sessionID else { return }
      active = nil
    }
  }
}

public final class IOSPCMSessionHandle: Sendable {
  private let state: IOSPCMSessionState
  private let readiness: Task<Void, Error>

  fileprivate init(state: IOSPCMSessionState) {
    self.state = state
    readiness = Task { try await state.startup() }
  }

  public func ready() async throws {
    try await readiness.value
  }

  public func heartbeat() async {
    await state.heartbeat()
  }

  public func extend(_ extensionValue: PCMSourceExtension) async throws {
    try await state.extend(extensionValue)
  }

  /// Binds a native maintenance owner to this exact live source and allowance.
  /// Inspection grants no new capture authority and cannot reopen a closed run.
  public func verifySource(authority: PCMSourceAuthority, maximumChunks: Int) async throws {
    try await state.verifySource(authority: authority, maximumChunks: maximumChunks)
  }

  public func stop(_ mode: PCMStopMode) async throws -> PCMStopResult {
    try await state.stop(mode)
  }
}

private final class FrameAdmissionGate: @unchecked Sendable {
  enum Claim { case accepted, overflow, closed }
  private let lock = NSLock()
  private var occupied = false
  private var closed = false

  func claim() -> Claim {
    lock.withLock {
      guard !closed else { return .closed }
      guard !occupied else {
        closed = true
        return .overflow
      }
      occupied = true
      return .accepted
    }
  }

  func release() { lock.withLock { occupied = false } }
  func close() { lock.withLock { closed = true } }
}

private final class FirstResult<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var resolved = false
  private var value: Value?
  private var waiter: CheckedContinuation<Value, Never>?

  func resolve(_ value: Value) {
    let continuation = lock.withLock { () -> CheckedContinuation<Value, Never>? in
      guard !resolved else { return nil }
      resolved = true
      guard let waiter else {
        self.value = value
        return nil
      }
      self.waiter = nil
      return waiter
    }
    continuation?.resume(returning: value)
  }

  func wait() async -> Value {
    await withCheckedContinuation { continuation in
      let existing = lock.withLock { () -> Value? in
        if let value {
          self.value = nil
          return value
        }
        waiter = continuation
        return nil
      }
      if let existing { continuation.resume(returning: existing) }
    }
  }
}

private actor IOSPCMSessionState {
  private enum Phase: Equatable {
    case owned
    case requestingPermission
    case starting
    case active
    case closing
    case closeFailed
    case closed
  }

  private struct InFlight {
    let sequence: UInt64
    let acknowledgement: any PCMAcknowledging
  }

  private let sessionID: UInt64
  private let configuration: PCMConfiguration
  private let permission: any MicrophonePermissionAuthorizing
  private let audio: any PCMAudioDriving
  private let sink: any PCMEmissionSink
  private let clock: any PCMClock
  private let sourceClock: any PCMSourceClock
  private let signalMonitor: PCMSignalMonitor?
  private var window: PCMSourceWindow?
  private var sourceInputFrames: Int64 = 0
  private var authorityTask: Task<Void, Never>?
  private var explicitStopRequested = false
  private var windowFinalPacket: PCMEncodedPacket?
  private let cancellation = StartupCancellation()
  private let frameAdmission = FrameAdmissionGate()
  private let markCloseFailed: @Sendable () -> Void
  private let releaseOwnership: @Sendable () -> Void
  private var phase: Phase = .owned
  private var requestedStopMode: PCMStopMode?
  private var inputFrozen = false
  private var released = false
  private var closingInProgress = false
  private var terminationSent = false
  private var resampler: AreaWeightedPCM16Resampler?
  private var sourceSampleRateHz: Int?
  private var resamplerFinished = false
  private var accumulator: PCMAccumulator
  private var nextSequence: UInt64 = 0
  private var inFlight: InFlight?
  private var deliveryTask: Task<Void, Never>?
  private var deliveryWaiters: [CheckedContinuation<Void, Never>] = []
  private var retainedFinalPacket: PCMEncodedPacket?
  private var watchdogTask: Task<Void, Never>?
  private var watchdogGeneration: UInt64 = 0
  private var closeWaiters: [CheckedContinuation<Void, Never>] = []

  init(
    sessionID: UInt64,
    configuration: PCMConfiguration,
    permission: any MicrophonePermissionAuthorizing,
    audio: any PCMAudioDriving,
    sink: any PCMEmissionSink,
    clock: any PCMClock,
    sourceClock: any PCMSourceClock,
    signalMonitor: PCMSignalMonitor?,
    window: PCMSourceWindow?,
    markCloseFailed: @escaping @Sendable () -> Void,
    releaseOwnership: @escaping @Sendable () -> Void
  ) {
    self.sessionID = sessionID
    self.configuration = configuration
    self.permission = permission
    self.audio = audio
    self.sink = sink
    self.clock = clock
    self.sourceClock = sourceClock
    self.signalMonitor = signalMonitor
    self.window = window
    self.markCloseFailed = markCloseFailed
    self.releaseOwnership = releaseOwnership
    accumulator = PCMAccumulator(frameCapacity: configuration.targetFramesPerChunk)
  }

  func startup() async throws {
    guard phase == .owned else { throw PCMFailure(.startupCancelled) }
    if let window, window.remainingNanoseconds(sourceClock.now()) == 0 {
      try await closeAfterStartupFailure(.startupCancelled)
    }
    phase = .requestingPermission
    armAuthorityDeadline()
    let permissionResult = await racePermission()
    guard phase == .requestingPermission, case .value(let permissionValue) = permissionResult
    else {
      throw PCMFailure(.startupCancelled)
    }
    switch permissionValue {
    case .granted:
      break
    case .denied:
      try await closeAfterStartupFailure(.permissionDenied)
    case .restricted:
      try await closeAfterStartupFailure(.permissionRestricted)
    case .unavailable:
      try await closeAfterStartupFailure(.microphoneUnavailable)
    }

    if let window, window.remainingNanoseconds(sourceClock.now()) == 0 {
      try await closeAfterStartupFailure(.startupCancelled)
    }

    phase = .starting
    let callbacks = PCMAudioCallbacks(
      frames: { [weak self, frameAdmission] frames in
        switch frameAdmission.claim() {
        case .closed:
          frames.zeroize()
          return PCMFrameAdmission(accepted: false)
        case .overflow:
          frames.zeroize()
          Task { await self?.receiveAdmissionOverflow() }
          return PCMFrameAdmission(accepted: false)
        case .accepted:
          let completion = Task { [weak self] in
            guard let self else {
              frames.zeroize()
              return
            }
            await self.receive(frames)
          }
          return PCMFrameAdmission(
            accepted: true,
            completion: completion,
            release: { frameAdmission.release() }
          )
        }
      },
      event: { [weak self] event in await self?.receive(event) }
    )
    switch await raceAudioStart(callbacks: callbacks) {
    case .cancelled:
      throw PCMFailure(.startupCancelled)
    case .failed:
      guard phase == .starting, !cancellation.isCancelled else {
        throw PCMFailure(.startupCancelled)
      }
      try await closeAfterStartupFailure(.startFailed)
    case .started:
      break
    }
    guard phase == .starting, !cancellation.isCancelled else {
      throw PCMFailure(.startupCancelled)
    }
    if let window, window.remainingNanoseconds(sourceClock.now()) == 0 {
      try await closeAfterStartupFailure(.startupCancelled)
    }
    phase = .active
    armWatchdog()
  }

  func heartbeat() {
    guard phase == .active else { return }
    armWatchdog()
  }

  private var maximumChunks: Int { window?.maximumChunks ?? configuration.maximumChunks }

  func verifySource(authority: PCMSourceAuthority, maximumChunks: Int) throws {
    guard phase == .active, let window, window.authority == authority,
      window.maximumChunks == maximumChunks,
      window.remainingNanoseconds(sourceClock.now()) > 0
    else { throw PCMFailure(.invalidConfiguration) }
  }

  func extend(_ value: PCMSourceExtension) throws {
    guard phase == .active, var next = window else {
      throw PCMFailure(.invalidConfiguration)
    }
    if next.remainingNanoseconds(sourceClock.now()) == 0 {
      beginWindowClose(.authorityExpired)
      throw PCMFailure(.invalidConfiguration)
    }
    do {
      try next.extend(value, now: sourceClock.now())
      try resampler?.extendMaximumOutputFrames(
        configuration.targetFramesPerChunk * next.maximumChunks)
      window = next
      armAuthorityDeadline()
    } catch {
      beginTerminal(.captureFailed)
      throw PCMFailure(.invalidConfiguration)
    }
  }

  func stop(_ mode: PCMStopMode, automatic: Bool = false) async throws -> PCMStopResult {
    if !automatic { explicitStopRequested = true }
    if phase == .closed { return completedWindowStop(mode, automatic: automatic) }
    applyStopRequest(mode)
    while closingInProgress {
      await withCheckedContinuation { closeWaiters.append($0) }
      if phase == .closed { return completedWindowStop(mode, automatic: automatic) }
    }
    closingInProgress = true
    defer { finishCloseOperation() }
    phase = .closing

    if !inputFrozen {
      do {
        try await audio.freezeInput(sessionID: sessionID)
        inputFrozen = true
      } catch {
        phase = .closeFailed
        markCloseFailed()
        throw PCMFailure(.stopFailed)
      }
    }
    await waitForDeliveries()
    if requestedStopMode == .drain {
      do {
        try prepareDrain()
        await waitForDeliveries()
        if requestedStopMode == .drain { try prepareFinalPacket() }
      } catch let failure as PCMFailure {
        beginTerminal(Self.termination(for: failure.code))
        await waitForDeliveries()
      } catch {
        beginTerminal(.invalidPCM)
        await waitForDeliveries()
      }
    }
    do {
      if !released {
        try await audio.release(sessionID: sessionID)
        released = true
      }
    } catch {
      phase = .closeFailed
      markCloseFailed()
      throw PCMFailure(.stopFailed)
    }

    phase = .closed
    releaseOwnership()
    let final = requestedStopMode == .drain ? retainedFinalPacket : nil
    retainedFinalPacket = nil
    if automatic {
      windowFinalPacket = final
      return PCMStopResult(finalPacket: nil)
    }
    return PCMStopResult(finalPacket: final)
  }

  private func completedWindowStop(_ mode: PCMStopMode, automatic: Bool) -> PCMStopResult {
    guard !automatic else { return PCMStopResult(finalPacket: nil) }
    let final = windowFinalPacket
    windowFinalPacket = nil
    if mode == .discard { final?.bytes.zeroize() }
    return PCMStopResult(finalPacket: mode == .drain ? final : nil)
  }

  private func closeAfterStartupFailure(_ code: PCMErrorCode) async throws -> Never {
    do {
      _ = try await stop(.discard)
    } catch {
      throw PCMFailure(.stopFailed)
    }
    throw PCMFailure(code)
  }

  private func receive(_ frames: OwnedAudioFrames) async {
    guard phase == .active else {
      frames.zeroize()
      return
    }
    if let window, window.remainingNanoseconds(sourceClock.now()) == 0 {
      frames.zeroize()
      beginWindowClose(.authorityExpired)
      return
    }
    do {
      var windowEnd: PCMWindowCloseReason?
      var output = try frames.consume { channels -> [Int16] in
        guard frames.sampleRateHz >= PCMConfiguration.sampleRateHz,
          frames.sampleRateHz <= 384_000,
          sourceSampleRateHz == nil || sourceSampleRateHz == frames.sampleRateHz
        else { throw PCMFailure(.invalidPCM) }
        var mono = try downmix(channels)
        defer {
          for index in mono.indices { mono[index] = 0 }
        }
        if let window {
          let maximumInput =
            Int64(configuration.targetFramesPerChunk * maximumChunks)
            * Int64(frames.sampleRateHz) / Int64(PCMConfiguration.sampleRateHz)
          let remainingInput = max(0, maximumInput - sourceInputFrames)
          let timeFrames = Int64(
            Double(window.remainingNanoseconds(sourceClock.now()))
              * Double(frames.sampleRateHz) / 1_000_000_000)
          let admitted = min(Int64(mono.count), remainingInput, timeFrames)
          if admitted < mono.count {
            for index in Int(admitted)..<mono.count { mono[index] = 0 }
            mono.removeLast(mono.count - Int(admitted))
          }
          sourceInputFrames += admitted
          if sourceInputFrames >= maximumInput {
            windowEnd = .frameLimit
          } else if admitted == timeFrames {
            windowEnd = .authorityExpired
          }
        }
        if resampler == nil {
          let maximumOutput =
            configuration.targetFramesPerChunk
            * maximumChunks
          resampler = try AreaWeightedPCM16Resampler(
            sourceRate: frames.sampleRateHz,
            targetRate: PCMConfiguration.sampleRateHz,
            maximumOutputFrames: maximumOutput
          )
          sourceSampleRateHz = frames.sampleRateHz
        }
        return try resampler!.push(mono)
      }
      signalMonitor?.recordConverted(output)
      try append(&output)
      if let windowEnd { beginWindowClose(windowEnd) }
    } catch let failure as PCMFailure {
      beginTerminal(Self.termination(for: failure.code))
    } catch {
      beginTerminal(.invalidPCM)
    }
  }

  private func receiveAdmissionOverflow() {
    guard phase == .active || phase == .starting else { return }
    beginTerminal(.bufferOverflow)
  }

  private func receive(_ event: PCMAudioEvent) {
    guard
      phase == .active || phase == .starting
        || (phase == .closing && requestedStopMode == .drain)
        || (phase == .closeFailed && requestedStopMode == .drain)
    else { return }
    switch event {
    case .interruption: beginTerminal(.interruption)
    case .routeChanged: beginTerminal(.routeChanged)
    case .backgrounded: beginTerminal(.backgrounded)
    case .permissionRevoked: beginTerminal(.permissionRevoked)
    case .captureFailed: beginTerminal(.captureFailed)
    }
  }

  private func downmix(_ channels: [[Float]]) throws -> [Float] {
    guard !channels.isEmpty,
      channels.count <= 32,
      let frameCount = channels.first?.count,
      frameCount > 0,
      frameCount <= configuration.maximumInputFramesPerBuffer,
      channels.allSatisfy({ $0.count == frameCount })
    else { throw PCMFailure(.invalidPCM) }
    guard channels.allSatisfy({ $0.allSatisfy(\.isFinite) }) else {
      throw PCMFailure(.invalidPCM)
    }
    var mono = Array(repeating: Float.zero, count: frameCount)
    for channel in channels {
      for index in channel.indices {
        mono[index] += channel[index]
      }
    }
    let scale = 1.0 / Double(channels.count)
    for index in mono.indices { mono[index] = Float(Double(mono[index]) * scale) }
    return mono
  }

  private func append(_ samples: inout [Int16]) throws {
    defer { for index in samples.indices { samples[index] = 0 } }
    var offset = 0
    while offset < samples.count {
      if accumulator.isFull {
        guard inFlight == nil else { throw PCMFailure(.bufferOverflow) }
        try startDelivery()
      }
      let availableFrames = (accumulator.storage.count - accumulator.count) / 2
      let end = min(samples.count, offset + availableFrames)
      try accumulator.append(samples, range: offset..<end)
      offset = end
      if accumulator.isFull, inFlight == nil { try startDelivery() }
    }
  }

  private func startDelivery() throws {
    guard inFlight == nil, accumulator.isFull else { return }
    guard nextSequence < UInt64(maximumChunks) else {
      throw PCMFailure(.outputLimitExceeded)
    }
    let packet = PCMEncodedPacket(
      sequenceNumber: nextSequence,
      bytes: accumulator.takeFull()
    )
    let acknowledgement: any PCMAcknowledging
    do {
      acknowledgement = try sink.emit(packet)
    } catch {
      packet.bytes.zeroize()
      throw PCMFailure(.sinkFailed)
    }
    packet.bytes.zeroize()
    let sequence = nextSequence
    nextSequence += 1
    inFlight = InFlight(sequence: sequence, acknowledgement: acknowledgement)
    deliveryTask = Task { [weak self] in
      let result = await acknowledgement.wait()
      await self?.deliveryCompleted(sequence: sequence, result: result)
    }
  }

  private func deliveryCompleted(
    sequence: UInt64,
    result: PCMAcknowledgementResult
  ) {
    guard inFlight?.sequence == sequence else { return }
    inFlight = nil
    deliveryTask = nil
    if case .failed = result {
      beginTerminal(.sinkFailed)
      resumeDeliveryWaiters()
      return
    }
    if accumulator.isFull,
      phase == .active || (phase == .closing && requestedStopMode == .drain)
    {
      do { try startDelivery() } catch let failure as PCMFailure {
        beginTerminal(Self.termination(for: failure.code))
      } catch {
        beginTerminal(.sinkFailed)
      }
    }
    if inFlight == nil { resumeDeliveryWaiters() }
  }

  private func waitForDeliveries() async {
    if requestedStopMode == .discard { inFlight?.acknowledgement.cancel() }
    if inFlight == nil { return }
    await withCheckedContinuation { deliveryWaiters.append($0) }
  }

  private func resumeDeliveryWaiters() {
    guard inFlight == nil else { return }
    let waiters = deliveryWaiters
    deliveryWaiters.removeAll(keepingCapacity: false)
    for waiter in waiters { waiter.resume() }
  }

  private func prepareDrain() throws {
    guard !resamplerFinished else { return }
    resamplerFinished = true
    if var current = resampler {
      var tail = try current.finish()
      resampler = current
      try append(&tail)
    }
    if accumulator.isFull, inFlight == nil { try startDelivery() }
  }

  private func prepareFinalPacket() throws {
    guard retainedFinalPacket == nil,
      let bytes = accumulator.takePartial()
    else { return }
    guard nextSequence < UInt64(maximumChunks) else {
      bytes.zeroize()
      throw PCMFailure(.outputLimitExceeded)
    }
    retainedFinalPacket = PCMEncodedPacket(sequenceNumber: nextSequence, bytes: bytes)
    nextSequence += 1
  }

  private func discardBufferedAudio() {
    accumulator.zeroize()
    resampler?.discard()
    resamplerFinished = true
    retainedFinalPacket?.bytes.zeroize()
    retainedFinalPacket = nil
    inFlight?.acknowledgement.cancel()
  }

  private func beginTerminal(_ code: PCMTerminationCode) {
    guard phase != .closed else { return }
    applyStopRequest(.discard)
    if !terminationSent {
      terminationSent = true
      sink.terminated(code)
    }
    guard !closingInProgress else { return }
    Task { [weak self] in _ = try? await self?.stop(.discard) }
  }

  private func beginWindowClose(_ reason: PCMWindowCloseReason) {
    guard phase == .active || phase == .starting || phase == .requestingPermission else { return }
    applyStopRequest(.drain)
    Task { [weak self] in await self?.finishWindowClose(reason) }
  }

  private func finishWindowClose(_ reason: PCMWindowCloseReason) async {
    do {
      _ = try await stop(.drain, automatic: true)
      if !explicitStopRequested, !terminationSent { sink.windowClosed(reason) }
    } catch {
      beginTerminal(.captureFailed)
    }
  }

  private func applyStopRequest(_ mode: PCMStopMode) {
    if requestedStopMode == nil || mode == .discard { requestedStopMode = mode }
    phase = .closing
    cancellation.cancel()
    cancelWatchdog()
    authorityTask?.cancel()
    authorityTask = nil
    frameAdmission.close()
    if requestedStopMode == .discard { discardBufferedAudio() }
  }

  private func finishCloseOperation() {
    closingInProgress = false
    let waiters = closeWaiters
    closeWaiters.removeAll(keepingCapacity: false)
    for waiter in waiters { waiter.resume() }
  }

  private enum PermissionRace: Sendable {
    case value(MicrophonePermission)
    case cancelled
  }

  private enum AudioStartRace: Sendable {
    case started
    case failed
    case cancelled
  }

  private func racePermission() async -> PermissionRace {
    let first = FirstResult<PermissionRace>()
    Task.detached { [permission, cancellation] in
      let value = await permission.requestPermission(cancellation: cancellation)
      first.resolve(.value(value))
    }
    Task.detached { [cancellation] in
      await cancellation.waitUntilCancelled()
      first.resolve(.cancelled)
    }
    return await first.wait()
  }

  private func raceAudioStart(callbacks: PCMAudioCallbacks) async -> AudioStartRace {
    let first = FirstResult<AudioStartRace>()
    Task.detached { [audio, cancellation, sessionID] in
      do {
        try await audio.start(
          sessionID: sessionID,
          callbacks: callbacks,
          cancellation: cancellation
        )
        first.resolve(.started)
      } catch {
        first.resolve(.failed)
      }
    }
    Task.detached { [cancellation] in
      await cancellation.waitUntilCancelled()
      first.resolve(.cancelled)
    }
    return await first.wait()
  }

  private func armWatchdog() {
    watchdogTask?.cancel()
    watchdogGeneration += 1
    let generation = watchdogGeneration
    let timeout = configuration.heartbeatTimeoutNanoseconds
    watchdogTask = Task { [weak self, clock] in
      do { try await clock.sleep(nanoseconds: timeout) } catch { return }
      guard !Task.isCancelled else { return }
      await self?.watchdogExpired(generation)
    }
  }

  private func armAuthorityDeadline() {
    authorityTask?.cancel()
    guard let window else { return }
    let generation = window.authority.generation
    let remaining = window.remainingNanoseconds(sourceClock.now())
    authorityTask = Task { [weak self, sourceClock] in
      do { try await sourceClock.sleep(nanoseconds: remaining) } catch { return }
      guard !Task.isCancelled else { return }
      await self?.authorityExpired(generation)
    }
  }

  private func authorityExpired(_ generation: Int) {
    guard let window, window.authority.generation == generation,
      phase == .active || phase == .starting || phase == .requestingPermission
    else { return }
    if window.remainingNanoseconds(sourceClock.now()) == 0 {
      beginWindowClose(.authorityExpired)
    } else {
      armAuthorityDeadline()
    }
  }

  private func watchdogExpired(_ generation: UInt64) {
    guard phase == .active, generation == watchdogGeneration else { return }
    beginTerminal(.heartbeatExpired)
  }

  private func cancelWatchdog() {
    watchdogTask?.cancel()
    watchdogTask = nil
    watchdogGeneration += 1
  }

  private static func termination(for code: PCMErrorCode) -> PCMTerminationCode {
    switch code {
    case .bufferOverflow: .bufferOverflow
    case .outputLimitExceeded: .outputLimitExceeded
    case .sinkFailed: .sinkFailed
    default: .invalidPCM
    }
  }
}
