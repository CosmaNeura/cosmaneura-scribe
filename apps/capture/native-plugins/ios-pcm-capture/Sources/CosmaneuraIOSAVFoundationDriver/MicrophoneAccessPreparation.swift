import Foundation

public struct AppleAudioInputDevice: Equatable, Sendable {
  public let id: String, label: String, kind: String
  public let current: Bool
  public var object: [String: Any] {
    ["id": id, "label": label, "kind": kind, "current": current]
  }
}

/// Metadata and OS permission only. This boundary deliberately exposes no
/// session activation, engine, tap, sample, meter, recording or authority API.
@MainActor protocol MicrophoneAccessPreparationSystem: AnyObject {
  var isForeground: Bool { get }
  func permission() -> AppleMicrophonePermissionState
  func requestPermission() async -> AppleMicrophonePermissionState
  /// Configure an inactive input catalogue; never activate or open the input.
  func configureInputCatalogue() throws
  func devices() -> [AppleAudioInputDevice]
}

@MainActor final class MicrophoneAccessPreparation {
  private let system: any MicrophoneAccessPreparationSystem
  private var token: UUID?
  private var requesting = false
  private var requireIdle: (@MainActor () throws -> Void)?
  private(set) var preferredInputID: String?

  init(system: any MicrophoneAccessPreparationSystem) { self.system = system }

  func begin(requireIdle: @escaping @MainActor () throws -> Void) throws -> [String: Any] {
    guard token == nil, system.isForeground else { throw AVFoundationDriverError.operationFailed }
    try requireIdle()
    self.requireIdle = requireIdle; token = UUID()
    do {
      if system.permission() == .granted { try system.configureInputCatalogue() }
      return try read()
    } catch { end(); throw AVFoundationDriverError.operationFailed }
  }

  /// Only the deliberate access button calls this method. A late OS result can
  /// neither reopen preparation nor carry a previous visit's selection forward.
  func requestRecordingAccess() async throws -> [String: Any] {
    let expected = try current()
    guard !requesting else { throw AVFoundationDriverError.operationFailed }
    requesting = true
    defer { if token == expected { requesting = false } }
    if system.permission() == .notDetermined { _ = await system.requestPermission() }
    guard try current() == expected else { throw AVFoundationDriverError.operationFailed }
    if system.permission() == .granted { try system.configureInputCatalogue() }
    return try read()
  }

  func select(id: String) throws -> [String: Any] {
    _ = try current()
    guard !requesting, system.permission() == .granted,
      !id.isEmpty, id.utf8.count <= 512, system.devices().contains(where: { $0.id == id })
    else { throw AVFoundationDriverError.operationFailed }
    // A next-start UID preference, not a claim that the inactive route changed.
    // The authorized recorder applies and validates it before admitting frames.
    preferredInputID = id
    return try read()
  }

  func read() throws -> [String: Any] {
    _ = try current()
    let permission = system.permission()
    let devices = permission == .granted ? system.devices() : []
    guard devices.count <= 32, Set(devices.map(\.id)).count == devices.count,
      devices.filter(\.current).count <= 1 else { throw AVFoundationDriverError.operationFailed }
    if !devices.contains(where: { $0.id == preferredInputID }) {
      preferredInputID = devices.first(where: \.current)?.id
    }
    // Granted access is not evidence of working audio. iOS may withhold the
    // catalogue while inactive; leave selection empty and validate the default
    // only inside the authorized recorder, never activate to populate this list.
    let status = permission == .granted ? "ready"
      : permission == .unavailable ? "unavailable" : "permission_required"
    return ["version": 1, "status": status, "inputDevices": devices.map(\.object),
      "selectedInputId": preferredInputID as Any? ?? NSNull(), "microphone": NSNull()]
  }

  func end() { token = nil; requesting = false; requireIdle = nil }

  private func current() throws -> UUID {
    guard let token, system.isForeground, let requireIdle else {
      throw AVFoundationDriverError.operationFailed
    }
    try requireIdle()
    return token
  }
}
