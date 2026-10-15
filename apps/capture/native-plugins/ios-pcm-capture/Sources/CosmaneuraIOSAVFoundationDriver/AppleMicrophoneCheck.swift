#if os(iOS)
  @preconcurrency import AVFoundation
  import Foundation
  import UIKit

  public struct AppleAudioInputDevice: Sendable {
    public let id: String, label: String, kind: String
    public let current: Bool
    public var object: [String: Any] {
      ["id": id, "label": label, "kind": kind, "current": current]
    }
  }

  /// A short foreground-only signal check. Tap samples are read in place for a
  /// scalar RMS level and immediately discarded: no PCM copy, encoder, sink,
  /// queue, source grant or clinical recording is created by this owner.
  @MainActor public final class AppleMicrophoneCheck {
    public static let shared = AppleMicrophoneCheck()
    private let levels = CheckLevels()
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var token: UUID?
    private var timeout: Task<Void, Never>?
    private var background: NSObjectProtocol?
    private var status = "unavailable"
    public private(set) var selectedPreference: (AppleMicrophoneInput, String)?
    public var isIdle: Bool { engine == nil }

    private init() {}

    public static func devices() -> [AppleAudioInputDevice] {
      let session = AVAudioSession.sharedInstance()
      let current = session.currentRoute.inputs.first?.uid
      return (session.availableInputs ?? []).compactMap { port in
        let kind = inputKind(port.portType)
        guard kind != nil else { return nil }
        return AppleAudioInputDevice(id: port.uid, label: port.portName,
          kind: kind!, current: port.uid == current)
      }
    }

    public static func selection(id: String) throws -> (AppleMicrophoneInput, String) {
      guard !id.isEmpty, id.utf8.count <= 512,
        let port = AVAudioSession.sharedInstance().availableInputs?.first(where: { $0.uid == id }),
        let kind = inputKind(port.portType), let input = AppleMicrophoneInput(rawValue: kind)
      else { throw AVFoundationDriverError.operationFailed }
      return (input, port.uid)
    }

    public func begin(requireIdle: @MainActor () throws -> Void) async throws -> [String: Any] {
      guard token == nil, engine == nil, UIApplication.shared.applicationState == .active
      else { throw AVFoundationDriverError.operationFailed }
      try requireIdle()
      let ticket = UUID()
      token = ticket; status = "checking"
      let granted = await AVAudioApplication.requestRecordPermission()
      guard token == ticket, UIApplication.shared.applicationState == .active else {
        throw AVFoundationDriverError.operationFailed
      }
      guard granted else { token = nil; status = "permission_required"; return snapshot() }
      do {
        try requireIdle()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
        try session.setActive(true)
        let next = AVAudioEngine()
        engine = next  // Failure/late cancellation retains stop custody.
        try installTap(next)
        next.prepare(); try next.start()
        rememberCurrentInput()
        status = "ready"
        background = NotificationCenter.default.addObserver(
          forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { _ in Task { @MainActor in try? AppleMicrophoneCheck.shared.end() } }
        timeout = Task { @MainActor [weak self] in
          try? await Task.sleep(for: .seconds(60))
          guard !Task.isCancelled, self?.token == ticket else { return }
          try? self?.end()
        }
        return snapshot()
      } catch {
        try? end()
        throw AVFoundationDriverError.operationFailed
      }
    }

    public func select(id: String) throws -> [String: Any] {
      guard engine != nil, token != nil else { throw AVFoundationDriverError.operationFailed }
      _ = try Self.selection(id: id)
      // Stop the meter graph before route changes; never mix old-route levels
      // with a new device's label. This owner holds no accepted clinical audio.
      let old = engine!
      if tapInstalled { old.inputNode.removeTap(onBus: 0); tapInstalled = false }
      old.stop()
      let session = AVAudioSession.sharedInstance()
      guard let port = session.availableInputs?.first(where: { $0.uid == id }) else {
        throw AVFoundationDriverError.operationFailed
      }
      do {
        try session.setPreferredInput(port)
        guard session.currentRoute.inputs.count == 1,
          session.currentRoute.inputs.first?.uid == id else { throw AVFoundationDriverError.operationFailed }
        let next = AVAudioEngine(); engine = next
        try installTap(next); next.prepare(); try next.start()
        rememberCurrentInput()
        return snapshot()
      } catch { try? end(); throw AVFoundationDriverError.operationFailed }
    }

    public func end() throws {
      levels.reset() // Fence any old callback already in flight before teardown.
      timeout?.cancel(); timeout = nil
      if let background { NotificationCenter.default.removeObserver(background) }
      background = nil; token = nil; status = "unavailable"
      if let engine {
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine.stop()
        // Physical graph is closed even if session deactivation reports busy.
        self.engine = nil
        try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      }
    }

    public func snapshot() -> [String: Any] {
      let devices = Self.devices()
      return ["version": 1, "status": status,
        "inputDevices": devices.map(\.object),
        "selectedInputId": devices.first(where: \.current)?.id as Any? ?? NSNull(),
        "microphone": levels.snapshot() as Any? ?? NSNull()]
    }

    private func installTap(_ engine: AVAudioEngine) throws {
      let input = engine.inputNode, format = input.outputFormat(forBus: 0)
      guard format.channelCount > 0, format.channelCount <= 32,
        format.sampleRate > 0, format.commonFormat == .pcmFormatFloat32,
        !format.isInterleaved else { throw AVFoundationDriverError.operationFailed }
      let generation = levels.reset()
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [levels] buffer, _ in
        levels.observe(buffer, generation: generation)
      }
      tapInstalled = true
    }

    private func rememberCurrentInput() {
      if let id = Self.devices().first(where: \.current)?.id {
        selectedPreference = try? Self.selection(id: id)
      }
    }

    private static func inputKind(_ port: AVAudioSession.Port) -> String? {
      switch port {
      case .builtInMic: "built_in"
      case .bluetoothHFP, .bluetoothLE: "bluetooth"
      case .usbAudio, .headsetMic, .lineIn: "external"
      default: nil
      }
    }
  }

  private final class CheckLevels: @unchecked Sendable {
    private let lock = NSLock()
    private var level: Double = 0
    private var timestamp: UInt64?
    private var generation: UInt64 = 0
    @discardableResult func reset() -> UInt64 {
      lock.withLock { generation &+= 1; level = 0; timestamp = nil; return generation }
    }
    func observe(_ buffer: AVAudioPCMBuffer, generation: UInt64) {
      guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return }
      let frames = min(Int(buffer.frameLength), 16384), channels = Int(buffer.format.channelCount)
      guard channels > 0, channels <= 32 else { return }
      var sum: Double = 0
      for channel in 0..<channels {
        for frame in 0..<frames {
          let value = Double(data[channel][frame])
          if value.isFinite { sum += value * value }
        }
      }
      let rms = min(1, sqrt(sum / Double(frames * channels)))
      lock.withLock {
        guard self.generation == generation else { return }
        level = rms; timestamp = DispatchTime.now().uptimeNanoseconds
      }
    }
    func snapshot() -> [String: Any]? {
      lock.withLock {
        guard let timestamp else { return nil }
        let age = Double(DispatchTime.now().uptimeNanoseconds - timestamp) / 1_000_000
        return ["level": age <= 1500 ? level : 0, "ageMs": age]
      }
    }
  }
#endif
