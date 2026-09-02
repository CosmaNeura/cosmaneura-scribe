#if os(iOS)
  @preconcurrency import AVFoundation
  import CosmaneuraIOSPCMCore
  import Foundation
  @preconcurrency import UIKit

  public struct LiveAppleApplicationForegroundProvider:
    AppleApplicationForegroundProviding, Sendable
  {
    public init() {}

    public func isForegroundActive() async -> Bool {
      await MainActor.run { UIApplication.shared.applicationState == .active }
    }
  }

  /// Thin live adapter. It is dormant until a future reviewed bridge creates it.
  public final class LiveAppleMicrophonePermissionProvider:
    AppleMicrophonePermissionProviding, @unchecked Sendable
  {
    public init() {}

    public func currentPermission() -> AppleMicrophonePermissionState {
      Self.map(AVAudioSession.sharedInstance().recordPermission)
    }

    public func requestPermission() async -> AppleMicrophonePermissionState {
      let granted = await withCheckedContinuation { continuation in
        AVAudioSession.sharedInstance().requestRecordPermission { allowed in
          continuation.resume(returning: allowed)
        }
      }
      return granted ? .granted : currentPermissionAfterDenial()
    }

    private func currentPermissionAfterDenial() -> AppleMicrophonePermissionState {
      let current = currentPermission()
      return current == .notDetermined ? .unavailable : current
    }

    private static func map(
      _ permission: AVAudioSession.RecordPermission
    ) -> AppleMicrophonePermissionState {
      switch permission {
      case .undetermined: .notDetermined
      case .granted: .granted
      case .denied: .denied
      @unknown default: .unavailable
      }
    }
  }

  /// Owns one AVAudioEngine at a time. All control methods are serialized by
  /// `AVFoundationPCMDriver`; only notification and tap callbacks are concurrent.
  public final class LiveAppleAudioSystem: AppleAudioSystem, @unchecked Sendable {
    private let lock = NSLock()
    private let notificationCenter: NotificationCenter
    private let audioSession: AVAudioSession
    private var engine = AVAudioEngine()
    private var tapInstalled = false
    private var activationAttempted = false
    private var eventHandler: (@Sendable (AppleAudioSystemEvent) -> Void)?
    private var observers: [NSObjectProtocol] = []

    public init(
      notificationCenter: NotificationCenter = .default,
      audioSession: AVAudioSession = .sharedInstance()
    ) {
      self.notificationCenter = notificationCenter
      self.audioSession = audioSession
    }

    deinit { clearEventHandler() }

    public func setEventHandler(
      _ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void
    ) {
      clearEventHandler()
      lock.withLock { eventHandler = handler }
      let tokens = [
        notificationCenter.addObserver(
          forName: AVAudioSession.interruptionNotification,
          object: audioSession,
          queue: nil
        ) { [weak self] note in
          guard
            let raw =
              (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue,
            let kind = AVAudioSession.InterruptionType(rawValue: raw)
          else {
            self?.emit(.captureFailed)
            return
          }
          if kind == .began { self?.emit(.interruptionBegan) }
        },
        notificationCenter.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: audioSession,
          queue: nil
        ) { [weak self] note in
          let raw = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
          let event: AppleAudioSystemEvent =
            AVAudioSession.RouteChangeReason(rawValue: raw ?? 0) == .categoryChange
            ? .configurationChanged : .routeChanged
          self?.emit(event)
        },
        notificationCenter.addObserver(
          forName: AVAudioSession.mediaServicesWereLostNotification,
          object: audioSession,
          queue: nil
        ) { [weak self] _ in self?.emit(.mediaServicesLost) },
        notificationCenter.addObserver(
          forName: AVAudioSession.mediaServicesWereResetNotification,
          object: audioSession,
          queue: nil
        ) { [weak self] _ in self?.emit(.mediaServicesReset) },
        notificationCenter.addObserver(
          forName: .AVAudioEngineConfigurationChange,
          object: engine,
          queue: nil
        ) { [weak self] _ in self?.emit(.captureFailed) },
        notificationCenter.addObserver(
          forName: UIApplication.willResignActiveNotification,
          object: nil,
          queue: nil
        ) { [weak self] _ in self?.emit(.backgrounded) },
        notificationCenter.addObserver(
          forName: UIApplication.didEnterBackgroundNotification,
          object: nil,
          queue: nil
        ) { [weak self] _ in self?.emit(.backgrounded) },
        notificationCenter.addObserver(
          forName: UIApplication.didBecomeActiveNotification,
          object: nil,
          queue: nil
        ) { [weak self] _ in self?.checkPermission() },
      ]
      lock.withLock { observers = tokens }
    }

    public func clearEventHandler() {
      let old = lock.withLock { () -> [NSObjectProtocol] in
        eventHandler = nil
        defer { observers.removeAll(keepingCapacity: false) }
        return observers
      }
      for observer in old { notificationCenter.removeObserver(observer) }
    }

    public func configureAndActivate(profile: AppleAudioSessionProfile) throws {
      guard case .foregroundTwoPartySpeech = profile else {
        throw AVFoundationDriverError.operationFailed
      }
      lock.withLock { activationAttempted = true }
      do {
        try audioSession.setCategory(
          .playAndRecord,
          mode: .voiceChat,
          options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try audioSession.setActive(true)
      } catch {
        throw AVFoundationDriverError.operationFailed
      }
    }

    public func installInputTap(
      frameCapacity: UInt32,
      handler: @escaping @Sendable (OwnedAudioFrames) -> Void
    ) throws {
      guard frameCapacity > 0,
        frameCapacity <= UInt32(PCMConfiguration.maximumFramesPerInputBuffer),
        !lock.withLock({ tapInstalled })
      else { throw AVFoundationDriverError.operationFailed }

      let input = engine.inputNode
      // The tap observes the input node's output bus; preserve that bus's exact
      // format rather than synthesizing a format at this boundary.
      let source = input.outputFormat(forBus: 0)
      guard source.sampleRate.isFinite,
        source.sampleRate >= Double(PCMConfiguration.sampleRateHz),
        source.sampleRate <= 384_000,
        source.channelCount > 0,
        source.channelCount <= 32,
        source.commonFormat == .pcmFormatFloat32,
        !source.isInterleaved
      else { throw AVFoundationDriverError.operationFailed }

      input.installTap(
        onBus: 0,
        bufferSize: AVAudioFrameCount(frameCapacity),
        format: source
      ) { [weak self] buffer, _ in
        guard let frames = Self.copyFrames(buffer) else {
          self?.emit(.captureFailed)
          return
        }
        handler(frames)
      }
      lock.withLock { tapInstalled = true }
    }

    public func startEngine() throws {
      do {
        engine.prepare()
        try engine.start()
      } catch {
        throw AVFoundationDriverError.operationFailed
      }
    }

    public func freezeInput() throws {
      let removeTap = lock.withLock { () -> Bool in
        defer { tapInstalled = false }
        return tapInstalled
      }
      if removeTap { engine.inputNode.removeTap(onBus: 0) }
      engine.stop()
    }

    public func deactivate() throws {
      let attempted = lock.withLock { activationAttempted }
      if attempted {
        do {
          try audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
          throw AVFoundationDriverError.operationFailed
        }
      }
      lock.withLock { activationAttempted = false }
      engine.reset()
      engine = AVAudioEngine()
    }

    private func emit(_ event: AppleAudioSystemEvent) {
      lock.withLock { eventHandler }?(event)
    }

    private func checkPermission() {
      guard audioSession.recordPermission != .granted else { return }
      emit(.permissionRevoked)
    }

    private static func copyFrames(_ buffer: AVAudioPCMBuffer) -> OwnedAudioFrames? {
      let count = Int(buffer.frameLength)
      let channelCount = Int(buffer.format.channelCount)
      let roundedRate = buffer.format.sampleRate.rounded()
      guard count > 0,
        count <= PCMConfiguration.maximumFramesPerInputBuffer,
        channelCount > 0,
        channelCount <= 32,
        buffer.format.commonFormat == .pcmFormatFloat32,
        !buffer.format.isInterleaved,
        roundedRate >= Double(PCMConfiguration.sampleRateHz),
        roundedRate <= 384_000,
        abs(buffer.format.sampleRate - roundedRate) < 0.001,
        let data = buffer.floatChannelData
      else { return nil }

      var channels: [[Float]] = []
      var transferred = false
      defer {
        if !transferred {
          for channel in channels.indices {
            for frame in channels[channel].indices { channels[channel][frame] = 0 }
          }
        }
      }
      channels.reserveCapacity(channelCount)
      for channel in 0..<channelCount {
        channels.append(Array(UnsafeBufferPointer(start: data[channel], count: count)))
      }
      let frames = OwnedAudioFrames(sampleRateHz: Int(roundedRate), channels: channels)
      transferred = true
      return frames
    }
  }
#endif
