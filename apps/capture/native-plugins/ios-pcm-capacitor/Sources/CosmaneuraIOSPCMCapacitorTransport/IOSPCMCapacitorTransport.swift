import CosmaneuraIOSPCMBridgeCore
import CosmaneuraIOSPCMCore
import Foundation

public enum IOSPCMCapacitorErrorCode: String, Error, Equatable, Sendable {
  case invalidArguments = "ios_capture_invalid_arguments"
  case microphonePermissionDenied = "ios_microphone_permission_denied"
  case microphonePermissionRestricted = "ios_microphone_permission_restricted"
  case microphoneUnavailable = "ios_microphone_unavailable"
  case notForeground = "ios_capture_not_foreground"
  case startFailed = "ios_capture_start_failed"
  case captureFailed = "ios_capture_failed"
  case stopFailed = "ios_capture_stop_failed"
}

public enum IOSPCMCapacitorAcknowledgement: String, Equatable, Sendable {
  case accepted
  case replayed
  case stale
}

public enum IOSPCMCapacitorReplay: String, Equatable, Sendable {
  case replayed
  case alreadyAcknowledged = "already_acknowledged"
  case stale
  case transportFailed = "transport_failed"
}

public struct IOSPCMCapacitorConfiguration: Equatable, Sendable {
  public let encoding: String
  public let channels: Int
  public let sampleRateHz: Int
  public let targetFramesPerChunk: Int
  public let maximumChunks: Int
  public let authority: PCMSourceAuthority?

  public init(
    encoding: String,
    channels: Int,
    sampleRateHz: Int,
    targetFramesPerChunk: Int,
    maximumChunks: Int,
    authority: PCMSourceAuthority? = nil
  ) throws {
    guard encoding == "pcm_s16le", channels == 1, sampleRateHz == 16_000,
      targetFramesPerChunk > 0, targetFramesPerChunk <= 960_000,
      maximumChunks > 0, maximumChunks <= 8_640,
      authority == nil || maximumChunks <= authority!.hardMaximumChunks
    else { throw IOSPCMCapacitorErrorCode.invalidArguments }
    self.encoding = encoding
    self.channels = channels
    self.sampleRateHz = sampleRateHz
    self.targetFramesPerChunk = targetFramesPerChunk
    self.maximumChunks = maximumChunks
    self.authority = authority
  }
}

public struct IOSPCMCapacitorPacket: Equatable, Sendable {
  public let sessionToken: String
  public let sequenceNumber: Int
  public let pcmBase64: String
}

public struct IOSPCMCapacitorStopResult: Equatable, Sendable {
  public let finalPcmPacket: IOSPCMCapacitorPacket?
}

public enum IOSPCMCapacitorEvent: Equatable, Sendable {
  case packet(IOSPCMCapacitorPacket)
  case interruption(sessionToken: String, code: String)
  case terminal(sessionToken: String, code: String)
  case windowClosed(sessionToken: String, reason: String)
}

public protocol IOSPCMCapacitorEventEmitting: AnyObject, Sendable {
  func emit(_ event: IOSPCMCapacitorEvent) throws
}

public protocol IOSPCMBridgeServing: Sendable {
  func confirmCaptureIdle() -> Bool
  var supportsRenewableCapture: Bool { get }
  func appState() async -> IOSPCMBridgeAppState
  func begin(configuration: IOSPCMBridgeConfiguration) throws -> IOSPCMBridgeSessionToken
  func ready(_ token: IOSPCMBridgeSessionToken) async throws
  func heartbeat(_ token: IOSPCMBridgeSessionToken) async throws
  func extend(_ token: IOSPCMBridgeSessionToken, value: PCMSourceExtension) async throws
  func stopForCapacitor(
    _ token: IOSPCMBridgeSessionToken,
    mode: IOSPCMBridgeStopMode
  ) async throws -> IOSPCMBridgePacket?
  func acknowledge(
    _ token: IOSPCMBridgeSessionToken,
    sequenceNumber: UInt64
  ) -> IOSPCMBridgeAcknowledgementResult
  func replayPendingPacket(
    _ token: IOSPCMBridgeSessionToken,
    sequenceNumber: UInt64
  ) -> IOSPCMBridgeReplayResult
}

extension IOSPCMBridgeServing {
  public func confirmCaptureIdle() -> Bool { false }
  public var supportsRenewableCapture: Bool { false }
  public func extend(_ token: IOSPCMBridgeSessionToken, value: PCMSourceExtension) async throws {
    throw IOSPCMBridgeFailure(.captureFailed)
  }
}

extension IOSPCMBridgeCore: IOSPCMBridgeServing {
  public var supportsRenewableCapture: Bool { true }
  public func stopForCapacitor(
    _ token: IOSPCMBridgeSessionToken,
    mode: IOSPCMBridgeStopMode
  ) async throws -> IOSPCMBridgePacket? {
    try await stop(token, mode: mode).finalPacket
  }
}

struct IOSPCMBase64Scratch {
  private(set) var bytes: Data

  init(copying source: UnsafeRawBufferPointer) {
    bytes = Data(source)
  }

  mutating func encodeAndClear() -> String {
    defer { bytes.resetBytes(in: bytes.startIndex..<bytes.endIndex) }
    return bytes.base64EncodedString()
  }

  var isZeroized: Bool { bytes.allSatisfy { $0 == 0 } }
}

public final class IOSPCMCapacitorEventPublisher: IOSPCMBridgeEventPublishing,
  @unchecked Sendable
{
  private weak var emitter: (any IOSPCMCapacitorEventEmitting)?

  public init(emitter: any IOSPCMCapacitorEventEmitting) {
    self.emitter = emitter
  }

  public func publish(_ event: IOSPCMBridgeEvent) throws {
    guard let emitter else { throw IOSPCMCapacitorErrorCode.captureFailed }
    switch event {
    case .windowClosed(let token, let reason):
      guard IOSPCMCapacitorTransport.validSessionToken(token.rawValue) else {
        throw IOSPCMCapacitorErrorCode.captureFailed
      }
      try emitter.emit(.windowClosed(sessionToken: token.rawValue, reason: reason.rawValue))
    case .packetAvailable(let packet):
      try emitter.emit(.packet(try Self.encode(packet, clearOwner: false)))
    case .interruption(let token, let code):
      guard IOSPCMCapacitorTransport.validSessionToken(token.rawValue) else {
        throw IOSPCMCapacitorErrorCode.captureFailed
      }
      try emitter.emit(.interruption(sessionToken: token.rawValue, code: code.rawValue))
    case .terminal(let token, let code):
      guard IOSPCMCapacitorTransport.validSessionToken(token.rawValue) else {
        throw IOSPCMCapacitorErrorCode.captureFailed
      }
      try emitter.emit(.terminal(sessionToken: token.rawValue, code: code.rawValue))
    }
  }

  static func encode(
    _ packet: IOSPCMBridgePacket,
    clearOwner: Bool
  ) throws -> IOSPCMCapacitorPacket {
    defer {
      if clearOwner { packet.bytes.zeroize() }
    }
    guard IOSPCMCapacitorTransport.validSessionToken(packet.sessionToken.rawValue),
      packet.sequenceNumber < 8_640,
      packet.bytes.count > 0,
      packet.bytes.count <= 1_920_000,
      packet.bytes.count.isMultiple(of: 2)
    else { throw IOSPCMCapacitorErrorCode.captureFailed }
    let encoded = packet.bytes.withUnsafeBytes { source -> String in
      var scratch = IOSPCMBase64Scratch(copying: source)
      return scratch.encodeAndClear()
    }
    return IOSPCMCapacitorPacket(
      sessionToken: packet.sessionToken.rawValue,
      sequenceNumber: Int(packet.sequenceNumber),
      pcmBase64: encoded
    )
  }
}

public final class IOSPCMCapacitorTransport: @unchecked Sendable {
  private let bridge: any IOSPCMBridgeServing

  public init(bridge: any IOSPCMBridgeServing) {
    self.bridge = bridge
  }

  public func getAppState() async -> String {
    await bridge.appState().rawValue
  }

  public func start(configuration: IOSPCMCapacitorConfiguration) throws -> String {
    guard configuration.authority == nil || bridge.supportsRenewableCapture else {
      throw IOSPCMCapacitorErrorCode.startFailed
    }
    do {
      return try bridge.begin(
        configuration: IOSPCMBridgeConfiguration(
          encoding: configuration.encoding,
          channels: configuration.channels,
          sampleRateHz: configuration.sampleRateHz,
          targetFramesPerChunk: configuration.targetFramesPerChunk,
          maximumChunks: configuration.maximumChunks,
          authority: configuration.authority
        )
      ).rawValue
    } catch let failure as IOSPCMBridgeStartFailure {
      throw Self.startFailure(failure.code)
    } catch {
      throw IOSPCMCapacitorErrorCode.startFailed
    }
  }

  public func ready(sessionToken: String) async throws {
    let token = try Self.token(sessionToken)
    do {
      try await bridge.ready(token)
    } catch let failure as IOSPCMBridgeStartFailure {
      throw Self.startFailure(failure.code)
    } catch is IOSPCMBridgeFailure {
      throw IOSPCMCapacitorErrorCode.captureFailed
    } catch {
      throw IOSPCMCapacitorErrorCode.startFailed
    }
  }

  public func heartbeat(sessionToken: String) async throws {
    let token = try Self.token(sessionToken)
    do {
      try await bridge.heartbeat(token)
    } catch {
      throw IOSPCMCapacitorErrorCode.captureFailed
    }
  }

  public var supportsRenewableCapture: Bool { bridge.supportsRenewableCapture }
  public func confirmCaptureIdle() -> Bool { bridge.confirmCaptureIdle() }

  public func extend(sessionToken: String, value: PCMSourceExtension) async throws {
    let token = try Self.token(sessionToken)
    guard bridge.supportsRenewableCapture else { throw IOSPCMCapacitorErrorCode.captureFailed }
    do { try await bridge.extend(token, value: value) }
    catch { throw IOSPCMCapacitorErrorCode.captureFailed }
  }

  public func stop(
    sessionToken: String,
    mode: IOSPCMBridgeStopMode
  ) async throws -> IOSPCMCapacitorStopResult {
    let token = try Self.token(sessionToken)
    do {
      let finalPacket = try await bridge.stopForCapacitor(token, mode: mode)
      return IOSPCMCapacitorStopResult(
        finalPcmPacket: try finalPacket.map {
          try IOSPCMCapacitorEventPublisher.encode($0, clearOwner: true)
        }
      )
    } catch let failure as IOSPCMBridgeFailure {
      switch failure.code {
      case .captureFailed: throw IOSPCMCapacitorErrorCode.captureFailed
      case .stopFailed: throw IOSPCMCapacitorErrorCode.stopFailed
      }
    } catch let failure as IOSPCMCapacitorErrorCode {
      throw failure
    } catch {
      throw IOSPCMCapacitorErrorCode.stopFailed
    }
  }

  public func acknowledge(
    sessionToken: String,
    sequenceNumber: Int
  ) throws -> IOSPCMCapacitorAcknowledgement {
    let token = try Self.token(sessionToken)
    let sequence = try Self.sequence(sequenceNumber)
    switch bridge.acknowledge(token, sequenceNumber: sequence) {
    case .accepted: return .accepted
    case .replayed: return .replayed
    case .stale: return .stale
    }
  }

  public func replayPendingPacket(
    sessionToken: String,
    sequenceNumber: Int
  ) throws -> IOSPCMCapacitorReplay {
    let token = try Self.token(sessionToken)
    let sequence = try Self.sequence(sequenceNumber)
    switch bridge.replayPendingPacket(token, sequenceNumber: sequence) {
    case .replayed: return .replayed
    case .alreadyAcknowledged: return .alreadyAcknowledged
    case .stale: return .stale
    case .transportFailed: return .transportFailed
    }
  }

  static func validSessionToken(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 85 else { return false }
    let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
    guard pieces.count == 2, let generation = UInt64(pieces[0]), generation > 0,
      String(generation) == pieces[0], !pieces[1].isEmpty, pieces[1].utf8.count <= 64
    else { return false }
    return pieces[1].utf8.allSatisfy {
      ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90)
        || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95
    }
  }

  private static func token(_ value: String) throws -> IOSPCMBridgeSessionToken {
    guard validSessionToken(value) else {
      throw IOSPCMCapacitorErrorCode.invalidArguments
    }
    return IOSPCMBridgeSessionToken(rawValue: value)
  }

  private static func sequence(_ value: Int) throws -> UInt64 {
    guard value >= 0, value < 8_640 else {
      throw IOSPCMCapacitorErrorCode.invalidArguments
    }
    return UInt64(value)
  }

  private static func startFailure(
    _ code: IOSPCMBridgeStartErrorCode
  ) -> IOSPCMCapacitorErrorCode {
    switch code {
    case .permissionDenied: .microphonePermissionDenied
    case .permissionRestricted: .microphonePermissionRestricted
    case .microphoneUnavailable: .microphoneUnavailable
    case .notForeground: .notForeground
    case .startFailed: .startFailed
    }
  }
}
