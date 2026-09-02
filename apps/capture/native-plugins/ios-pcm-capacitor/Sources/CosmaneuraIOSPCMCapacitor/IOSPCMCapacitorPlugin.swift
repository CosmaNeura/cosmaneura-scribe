#if os(iOS)
  @preconcurrency import Capacitor
  import CosmaneuraIOSPCMBridgeCore
  import CosmaneuraIOSPCMCapacitorTransport
  import Foundation

  @objc(IOSPCMCapacitorPlugin)
  public final class IOSPCMCapacitorPlugin: CAPPlugin, CAPBridgedPlugin,
    IOSPCMCapacitorEventEmitting, @unchecked Sendable
  {
    public let identifier = "IOSPCMCapacitorPlugin"
    public let jsName = "IOSPCM"
    public let pluginMethods: [CAPPluginMethod] = [
      CAPPluginMethod(name: "getAppState", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "heartbeat", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
      CAPPluginMethod(name: "replayPendingPacket", returnType: CAPPluginReturnPromise),
    ]

    private var transport: IOSPCMCapacitorTransport?

    public override func load() {
      let publisher = IOSPCMCapacitorEventPublisher(emitter: self)
      transport = IOSPCMCapacitorTransport(bridge: IOSPCMBridgeCore(events: publisher))
    }

    @objc public func getAppState(_ call: CAPPluginCall) {
      perform(call) { transport in
        ["state": await transport.getAppState()]
      }
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
      do {
        let configuration = try IOSPCMCapacitorConfiguration(
          encoding: encoding,
          channels: channels,
          sampleRateHz: sampleRateHz,
          targetFramesPerChunk: targetFramesPerChunk,
          maximumChunks: maximumChunks
        )
        call.resolve(["sessionToken": try transport.start(configuration: configuration)])
      } catch {
        reject(call, error: error)
      }
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
