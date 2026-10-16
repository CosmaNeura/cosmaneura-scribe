#if os(iOS)
  @preconcurrency import AVFoundation
  import Foundation
  import UIKit

  /// Foreground input catalogue and explicit OS access setup. This owner never
  /// activates audio, constructs an engine, installs a tap or observes samples.
  @MainActor public final class AppleMicrophoneCheck {
    public static let shared = AppleMicrophoneCheck()
    private let preparation = MicrophoneAccessPreparation(system: AppleInputCatalogue())
    private var background: NSObjectProtocol?
    /// Metadata preparation has no physical recording graph to retain.
    public var isIdle: Bool { true }
    public var selectedPreference: (AppleMicrophoneInput, String)? {
      guard let id = preparation.preferredInputID else { return nil }
      return try? Self.selection(id: id)
    }

    private init() {}

    public static func devices() -> [AppleAudioInputDevice] {
      let session = AVAudioSession.sharedInstance()
      let current = session.currentRoute.inputs.first?.uid
      return (session.availableInputs ?? []).compactMap { port in
        guard let kind = inputKind(port.portType) else { return nil }
        return AppleAudioInputDevice(id: port.uid, label: port.portName,
          kind: kind, current: port.uid == current)
      }
    }

    public static func selection(id: String) throws -> (AppleMicrophoneInput, String) {
      guard !id.isEmpty, id.utf8.count <= 512,
        let port = AVAudioSession.sharedInstance().availableInputs?.first(where: { $0.uid == id }),
        let kind = inputKind(port.portType), let input = AppleMicrophoneInput(rawValue: kind)
      else { throw AVFoundationDriverError.operationFailed }
      return (input, port.uid)
    }

    public func begin(requireIdle: @escaping @MainActor () throws -> Void) throws -> [String: Any] {
      let value = try preparation.begin(requireIdle: requireIdle)
      background = NotificationCenter.default.addObserver(
        forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
      ) { _ in Task { @MainActor in AppleMicrophoneCheck.shared.end() } }
      return value
    }

    public func requestRecordingAccess() async throws -> [String: Any] {
      try await preparation.requestRecordingAccess()
    }

    public func select(id: String) throws -> [String: Any] { try preparation.select(id: id) }

    public func end() {
      preparation.end()
      if let background { NotificationCenter.default.removeObserver(background) }
      background = nil
    }

    public func snapshot() -> [String: Any] {
      (try? preparation.read()) ?? ["version": 1, "status": "unavailable", "inputDevices": [],
        "selectedInputId": NSNull(), "microphone": NSNull()]
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

  @MainActor private final class AppleInputCatalogue: MicrophoneAccessPreparationSystem {
    var isForeground: Bool { UIApplication.shared.applicationState == .active }
    func permission() -> AppleMicrophonePermissionState {
      switch AVAudioApplication.shared.recordPermission {
      case .undetermined: .notDetermined
      case .denied: .denied
      case .granted: .granted
      @unknown default: .unavailable
      }
    }
    func requestPermission() async -> AppleMicrophonePermissionState {
      _ = await AVAudioApplication.requestRecordPermission()
      return permission()
    }
    func configureInputCatalogue() throws {
      // The caller verifies physical/native ownership is idle first. Category
      // configuration exposes availableInputs without opening microphone input.
      // Activation and setPreferredInput belong to the authorized recorder.
      try AVAudioSession.sharedInstance().setCategory(.record, mode: .measurement,
        options: [.allowBluetoothHFP])
    }
    func devices() -> [AppleAudioInputDevice] { AppleMicrophoneCheck.devices() }
  }
#endif
