#if os(iOS)
  @preconcurrency import Capacitor
  import CosmaneuraIOSPCMBridgeCore
  import CosmaneuraIOSPCMCapacitorTransport
  import CosmaneuraIOSPCMCore
  import CoreFoundation
  import Foundation
  import AVFAudio
  import CosmasNativeAuth

  @objc(IOSPCMCapacitorPlugin)
  public final class IOSPCMCapacitorPlugin: CAPPlugin, CAPBridgedPlugin,
    IOSPCMCapacitorEventEmitting, @unchecked Sendable
  {
    public let identifier = "IOSPCMCapacitorPlugin"
    public let jsName = "IOSPCM"
    public let pluginMethods: [CAPPluginMethod] = [
      CAPPluginMethod(name: "getCaptureSignal", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "selectMicrophoneInput", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "getAppState", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "confirmCaptureIdle", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "getCaptureCapabilities", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "extend", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "heartbeat", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "replayPendingPacket", returnType: CAPPluginReturnPromise),
    ]

    private var signalBridge: IOSPCMBridgeCore?
    private var transport: IOSPCMCapacitorTransport?

    public override func load() {
      let publisher = IOSPCMCapacitorEventPublisher(emitter: self)
      let bridge = IOSPCMBridgeCore(events: publisher)
      signalBridge = bridge
      let native = IOSPCMCapacitorTransport(bridge: bridge)
      transport = native
      Task { @MainActor in
        NativeCaptureStartGate.registerIdleProbe { native.confirmCaptureIdle() }
      }
    }

    @objc public func selectMicrophoneInput(_ call: CAPPluginCall) {
      guard let signalBridge, let input = call.getString("input"),
        Set(call.options.keys) == Set(["input"]), ["built_in", "bluetooth"].contains(input)
      else {
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      do {
        try signalBridge.selectMicrophoneInput(input)
        call.resolve(["version": 1, "input": input])
      } catch { reject(call, error: error) }
    }

    @objc public func getCaptureSignal(_ call: CAPPluginCall) {
      guard let signal = signalBridge?.captureSignal() else {
        call.resolve(["version": 2, "signal": NSNull()])
        return
      }
      call.resolve(["version": 2, "signal": [
        "inputBuffers": signal.inputBuffers, "convertedBuffers": signal.convertedBuffers,
        "inputEverNonzero": signal.inputEverNonzero, "convertedEverNonzero": signal.convertedEverNonzero,
        "inputLevel": signal.inputLevel, "convertedLevel": signal.convertedLevel,
        "inputAgeMs": signal.inputAgeMs.map { $0 as Any } ?? NSNull(),
        "convertedAgeMs": signal.convertedAgeMs.map { $0 as Any } ?? NSNull(),
        "zeroInputMs": signal.zeroInputMs, "route": signal.route.rawValue,
        // Observe iOS's per-app mute; never override the user's mute choice.
        "inputMuted": AVAudioApplication.shared.isInputMuted,
      ]])
    }

    @objc public func getAppState(_ call: CAPPluginCall) {
      perform(call) { transport in
        ["state": await transport.getAppState()]
      }
    }

    @objc public func confirmCaptureIdle(_ call: CAPPluginCall) {
      guard let transport else {
        reject(call, error: IOSPCMCapacitorErrorCode.captureFailed)
        return
      }
      call.resolve(["version": 1, "idle": transport.confirmCaptureIdle()])
    }

    @objc public func getCaptureCapabilities(_ call: CAPPluginCall) {
      guard transport != nil else {
        reject(call, error: IOSPCMCapacitorErrorCode.captureFailed)
        return
      }
      call.resolve(["version": 1, "renewableAuthority": false])
    }

    @objc public func start(_ call: CAPPluginCall) {
      guard let transport,
        let encoding = call.getString("encoding"),
        let channels = call.getInt("channels"),
        let sampleRateHz = call.getInt("sampleRateHz"),
        let targetFramesPerChunk = call.getInt("targetFramesPerChunk"),
        let maximumChunks = call.getInt("maximumChunks")
      else {
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      Task { @MainActor in
       do {
        _ = try IOSPCMCapacitorConfiguration(encoding: encoding, channels: channels,
          sampleRateHz: sampleRateHz, targetFramesPerChunk: targetFramesPerChunk,
          maximumChunks: maximumChunks, authority: nil)
        let ticket = try NativeCaptureStartGate.startTicket()
        guard Bundle.main.bundleIdentifier == "com.cosmaneura.scribe.beta",
              !call.options.keys.contains("authority"),
              await AVAudioApplication.requestRecordPermission() else {
          throw IOSPCMCapacitorErrorCode.captureFailed
        }
        let token = try await NativeCaptureStartGate.consume(owner: ticket) { permit in
        let authority = try PCMSourceAuthority(runID: permit.runID, generation: 1,
          expiresAtMilliseconds: Int64(permit.captureExpiresAt.timeIntervalSince1970 * 1000),
          hardMaximumChunks: maximumChunks)

        let configuration = try IOSPCMCapacitorConfiguration(
          encoding: encoding,
          channels: channels,
          sampleRateHz: sampleRateHz,
          targetFramesPerChunk: targetFramesPerChunk,
          maximumChunks: maximumChunks,
          authority: authority
        )
        guard permit.startExpiresAt > Date() else { throw IOSPCMCapacitorErrorCode.captureFailed }
        return try transport.start(configuration: configuration)
        }
        call.resolve(["sessionToken": token])
      } catch {
        reject(call, error: error)
       }
      }
    }

    @objc public func extend(_ call: CAPPluginCall) {
      // Upload renewal does not extend this native source's fixed server deadline.
      if Bundle.main.bundleIdentifier == "com.cosmaneura.scribe.beta" {
        reject(call, error: IOSPCMCapacitorErrorCode.captureFailed)
        return
      }
      guard let token = call.getString("sessionToken"),
        let value = call.getObject("extension"),
        Set(value.keys) == Set(["runId", "generation", "expiresAtMs", "maximumChunks"]),
        let runID = value["runId"] as? String,
        let generation = Self.exactInteger(value["generation"]),
        let expires = Self.exactInteger(value["expiresAtMs"]),
        let maximum = Self.exactInteger(value["maximumChunks"])
      else {
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      let extensionValue = PCMSourceExtension(runID: runID, generation: generation,
        expiresAtMilliseconds: Int64(expires), maximumChunks: maximum)
      perform(call) { transport in
        try await transport.extend(sessionToken: token, value: extensionValue)
        return ["sessionToken": token, "runId": runID, "generation": generation,
          "expiresAtMs": expires, "maximumChunks": maximum]
      }
    }

    private static func exactInteger(_ value: Any?) -> Int? {
      guard let number = value as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
        abs(number.doubleValue) <= 9_007_199_254_740_991,
        number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
      return number.intValue
    }

    @objc public func ready(_ call: CAPPluginCall) {
      guard let sessionToken = call.getString("sessionToken") else {
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      perform(call) { transport in
        try await transport.ready(sessionToken: sessionToken)
        return [:]
      }
    }

    @objc public func heartbeat(_ call: CAPPluginCall) {
      guard let sessionToken = call.getString("sessionToken") else {
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      perform(call) { transport in
        try await transport.heartbeat(sessionToken: sessionToken)
        return [:]
      }
    }

    @objc public func stop(_ call: CAPPluginCall) {
      guard let sessionToken = call.getString("sessionToken"),
        let rawMode = call.getString("mode")
      else {
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      let mode: IOSPCMBridgeStopMode
      switch rawMode {
      case "drain": mode = .drain
      case "discard": mode = .discard
      default:
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      perform(call) { transport in
        let result = try await transport.stop(sessionToken: sessionToken, mode: mode)
        return [
          "finalPcmPacket": result.finalPcmPacket.map(Self.packetObject) ?? NSNull()
        ]
      }
    }

    @objc public func acknowledge(_ call: CAPPluginCall) {
      guard let sessionToken = call.getString("sessionToken"),
        let sequenceNumber = call.getInt("sequenceNumber"), let transport
      else {
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      do {
        let result = try transport.acknowledge(
          sessionToken: sessionToken,
          sequenceNumber: sequenceNumber
        )
        call.resolve(["result": result.rawValue])
      } catch {
        reject(call, error: error)
      }
    }

    @objc public func replayPendingPacket(_ call: CAPPluginCall) {
      guard let sessionToken = call.getString("sessionToken"),
        let sequenceNumber = call.getInt("sequenceNumber"), let transport
      else {
        reject(call, error: IOSPCMCapacitorErrorCode.invalidArguments)
        return
      }
      do {
        let result = try transport.replayPendingPacket(
          sessionToken: sessionToken,
          sequenceNumber: sequenceNumber
        )
        call.resolve(["result": result.rawValue])
      } catch {
        reject(call, error: error)
      }
    }

    public func emit(_ event: IOSPCMCapacitorEvent) throws {
      DispatchQueue.main.async { [weak self] in
        self?.notifyListeners("iosNativePcmEvent", data: Self.eventObject(event))
      }
    }

    private func perform(
      _ call: CAPPluginCall,
      operation: @escaping @Sendable (IOSPCMCapacitorTransport) async throws -> JSObject
    ) {
      guard let transport else {
        reject(call, error: IOSPCMCapacitorErrorCode.captureFailed)
        return
      }
      Task { @MainActor [weak self] in
        do {
          call.resolve(try await operation(transport))
        } catch {
          self?.reject(call, error: error)
        }
      }
    }

    private func reject(_ call: CAPPluginCall, error: Error) {
      let code =
        (error as? IOSPCMCapacitorErrorCode)?.rawValue
        ?? IOSPCMCapacitorErrorCode.captureFailed.rawValue
      call.reject(code, code)
    }

    private static func packetObject(_ packet: IOSPCMCapacitorPacket) -> JSObject {
      [
        "sessionToken": packet.sessionToken,
        "sequenceNumber": packet.sequenceNumber,
        "pcmBase64": packet.pcmBase64,
      ]
    }

    private static func eventObject(_ event: IOSPCMCapacitorEvent) -> JSObject {
      switch event {
      case .windowClosed(let sessionToken, let reason):
        return ["kind": "window_closed", "sessionToken": sessionToken, "reason": reason]
      case .packet(let packet):
        return ["kind": "packet", "packet": packetObject(packet)]
      case .interruption(let sessionToken, let code):
        return ["kind": "interruption", "sessionToken": sessionToken, "code": code]
      case .terminal(let sessionToken, let code):
        return ["kind": "terminal", "sessionToken": sessionToken, "code": code]
      }
    }
  }
#endif
