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
    private let signalMonitor: PCMSignalMonitor?
    private let microphoneInput: AppleMicrophoneInputPreference
    private let inputRouteEvents = AppleInputRouteEvents()
    private var selectedInputUID: String?
    private var engine = AVAudioEngine()
    private var tapInstalled = false
    private var activationAttempted = false
    private var eventHandler: (@Sendable (AppleAudioSystemEvent) -> Void)?
    private var observers: [NSObjectProtocol] = []

    public init(
      notificationCenter: NotificationCenter = .default,
      audioSession: AVAudioSession = .sharedInstance(),
      signalMonitor: PCMSignalMonitor? = nil,
      microphoneInput: AppleMicrophoneInputPreference = AppleMicrophoneInputPreference()
    ) {
      self.notificationCenter = notificationCenter
      self.audioSession = audioSession
      self.signalMonitor = signalMonitor
      self.microphoneInput = microphoneInput
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
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw ?? 0)
          guard let self else { return }
          // Activation can announce a route before setPreferredInput has set
          // selectedInputUID, especially after deactivation on Pause. Treat
          // notifications inside that bounded configuration operation as setup;
          // the selected port is verified before installing/starting the tap.
          // Once armed, even configuration notifications remain terminal.
          let configured =
            reason == .categoryChange
            || (reason == .override || reason == .routeConfigurationChange)
              && self.hasSelectedInput()
          self.emit(self.inputRouteEvents.routeChange(knownConfiguration: configured))
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
        ) { [weak self] _ in
          PCMStartupDiagnostics.shared.record(.engineConfigurationChanged)
          self?.emit(.captureFailed)
        },
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
      // Both profiles use the same native input graph. Only the trusted driver
      // lifecycle differs; the legacy PCM bridge keeps foreground-only capture.
      switch profile {
      case .foregroundTwoPartySpeech, .nativeEncryptedSpeech: break
      }
      lock.withLock { activationAttempted = true }
      do {
        try inputRouteEvents.withInputConfiguration {
          let selected = microphoneInput.selected
          // This adapter records an in-person conversation and has no playback
          // graph. Use recording input without the VoIP route/processing policy.
          try audioSession.setCategory(
            .record,
            mode: .measurement,
            options: selected == .bluetooth ? [.allowBluetoothHFP] : []
          )
          try audioSession.setActive(true)
          let portTypes: [AVAudioSession.Port]
          switch selected {
          case .builtIn: portTypes = [.builtInMic]
          case .bluetooth: portTypes = [.bluetoothHFP]
          case .external: portTypes = [.usbAudio, .headsetMic]
          }
          let available = (audioSession.availableInputs ?? []).filter {
            portTypes.contains($0.portType)
          }
          // Keep the current eligible accessory if several are connected.
          let currentUID = audioSession.currentRoute.inputs.first?.uid
          guard let port = available.first(where: { $0.uid == currentUID }) ?? available.first
          else {
            throw AVFoundationDriverError.operationFailed
          }
          lock.withLock { selectedInputUID = port.uid }
          try audioSession.setPreferredInput(port)
          guard hasSelectedInput() else { throw AVFoundationDriverError.operationFailed }
          signalMonitor?.setRoute(Self.inputRoute(audioSession.currentRoute))
        }
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
        !lock.withLock({ tapInstalled }), hasSelectedInput()
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
        guard let frames = Self.copyFrames(buffer, signalMonitor: self?.signalMonitor) else {
          self?.emit(.captureFailed)
          return
        }
        handler(frames)
      }
      lock.withLock { tapInstalled = true }
    }

    public func startEngine() throws {
      do {
        guard hasSelectedInput() else { throw AVFoundationDriverError.operationFailed }
        engine.prepare()
        try engine.start()
        guard hasSelectedInput() else { throw AVFoundationDriverError.operationFailed }
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
      lock.withLock {
        activationAttempted = false
        selectedInputUID = nil
      }
      engine.reset()
      engine = AVAudioEngine()
    }

    private func hasSelectedInput() -> Bool {
      guard let uid = lock.withLock({ selectedInputUID }) else { return false }
      let inputs = audioSession.currentRoute.inputs
      return inputs.count == 1 && inputs.first?.uid == uid
    }

    private func emit(_ event: AppleAudioSystemEvent) {
      let diagnostic: PCMStartupEvent
      switch event {
      case .configurationChanged: diagnostic = .sessionConfigurationChanged
      case .interruptionBegan: diagnostic = .interrupted
      case .routeChanged: diagnostic = .routeChanged
      case .mediaServicesLost: diagnostic = .mediaServicesLost
      case .mediaServicesReset: diagnostic = .mediaServicesReset
      case .backgrounded: diagnostic = .backgrounded
      case .permissionRevoked: diagnostic = .permissionRevoked
      case .captureFailed: diagnostic = .captureFailed
      }
      PCMStartupDiagnostics.shared.record(diagnostic)
      lock.withLock { eventHandler }?(event)
    }

    private func checkPermission() {
      guard audioSession.recordPermission != .granted else { return }
      emit(.permissionRevoked)
    }

    private static func inputRoute(_ route: AVAudioSessionRouteDescription)
      -> PCMSignalMonitor.InputRoute
    {
      guard let input = route.inputs.first else { return .none }
      switch input.portType {
      case .builtInMic: return .builtIn
      case .bluetoothHFP, .bluetoothLE: return .bluetooth
      case .headsetMic, .lineIn: return .wired
      case .usbAudio: return .usb
      default: return .other
      }
    }

    private static func copyFrames(_ buffer: AVAudioPCMBuffer, signalMonitor: PCMSignalMonitor?)
      -> OwnedAudioFrames?
    {
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
      signalMonitor?.recordInput(channels, sampleRateHz: Int(roundedRate))
      let frames = OwnedAudioFrames(sampleRateHz: Int(roundedRate), channels: channels)
      transferred = true
      return frames
    }
  }
#endif
