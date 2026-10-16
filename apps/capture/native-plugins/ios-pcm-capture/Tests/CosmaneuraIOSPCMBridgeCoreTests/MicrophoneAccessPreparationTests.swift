import Foundation
import Testing
@testable import CosmaneuraIOSAVFoundationDriver

@MainActor struct MicrophoneAccessPreparationTests {
  @Test func catalogueAndSelectionNeverRequestPermissionAndExposeNoMeter() throws {
    let system = PreparationSystem(permission: .granted)
    let preparation = MicrophoneAccessPreparation(system: system)
    let opened = try preparation.begin(requireIdle: {})
    #expect(opened["status"] as? String == "ready")
    #expect(opened["microphone"] is NSNull)
    let selected = try preparation.select(id: "synthetic-headset")
    #expect(selected["selectedInputId"] as? String == "synthetic-headset")
    let devices = selected["inputDevices"] as? [[String: Any]]
    #expect(devices?.first(where: { $0["current"] as? Bool == true })?["id"] as? String == "synthetic-built-in")
    #expect(system.requests == 0)
    #expect(system.catalogueConfigurations == 1)
    preparation.end()
    #expect(preparation.preferredInputID == "synthetic-headset")
  }

  @Test(arguments: [AppleMicrophonePermissionState.notDetermined, .denied, .restricted, .unavailable])
  func openingWithoutAccessNeverPromptsOrConfiguresInput(_ permission: AppleMicrophonePermissionState) throws {
    let system = PreparationSystem(permission: permission)
    let preparation = MicrophoneAccessPreparation(system: system)
    let opened = try preparation.begin(requireIdle: {})
    #expect(opened["status"] as? String == (permission == .unavailable ? "unavailable" : "permission_required"))
    #expect(opened["microphone"] is NSNull)
    #expect(system.requests == 0)
    #expect(system.catalogueConfigurations == 0)
    #expect(throws: AVFoundationDriverError.self) { try preparation.select(id: "synthetic-built-in") }
  }

  @Test func inactiveEmptyCatalogueDefersDefaultValidationToAuthorizedRecording() throws {
    let system = PreparationSystem(permission: .granted)
    system.catalogueEmpty = true
    let preparation = MicrophoneAccessPreparation(system: system)
    let opened = try preparation.begin(requireIdle: {})
    #expect(opened["status"] as? String == "ready")
    #expect((opened["inputDevices"] as? [[String: Any]])?.isEmpty == true)
    #expect(opened["selectedInputId"] is NSNull)
    #expect(opened["microphone"] is NSNull)
    #expect(preparation.preferredInputID == nil)
    #expect(system.requests == 0)
    #expect(system.catalogueConfigurations == 1)
    #expect(throws: AVFoundationDriverError.self) { try preparation.select(id: "synthetic-built-in") }
  }

  @Test func explicitAccessRequestChecksIdleAndDoesNotCreateRecordingAuthority() async throws {
    let system = PreparationSystem(permission: .notDetermined)
    let preparation = MicrophoneAccessPreparation(system: system)
    _ = try preparation.begin(requireIdle: { system.idleChecks += 1 })
    let checked = try await preparation.requestRecordingAccess()
    #expect(system.requests == 1)
    #expect(system.catalogueConfigurations == 1)
    #expect(system.idleChecks >= 4)
    #expect(checked["status"] as? String == "ready")
    #expect(checked["microphone"] is NSNull)
    #expect(Set(checked.keys) == Set(["version", "status", "inputDevices", "selectedInputId", "microphone"]))
  }

  @Test func permissionResponseAfterCloseCannotConfigureOrReopenInput() async throws {
    let system = PreparationSystem(permission: .notDetermined, suspendRequest: true)
    let preparation = MicrophoneAccessPreparation(system: system)
    _ = try preparation.begin(requireIdle: {})
    let asking = Task { @MainActor in _ = try await preparation.requestRecordingAccess() }
    defer { preparation.end(); system.finishFixture(); asking.cancel() }
    try await system.waitForRequest()
    preparation.end()
    system.completeRequest()
    await #expect(throws: AVFoundationDriverError.self) { try await asking.value }
    #expect(system.catalogueConfigurations == 0)
    #expect(throws: AVFoundationDriverError.self) { try preparation.read() }
  }

  @Test func lateAccessResponseCannotMutateReplacementPreparation() async throws {
    let system = PreparationSystem(permission: .notDetermined, suspendRequest: true)
    let preparation = MicrophoneAccessPreparation(system: system)
    _ = try preparation.begin(requireIdle: {})
    let asking = Task { @MainActor in _ = try await preparation.requestRecordingAccess() }
    defer { preparation.end(); system.finishFixture(); asking.cancel() }
    try await system.waitForRequest()
    preparation.end()
    _ = try preparation.begin(requireIdle: {})
    system.completeRequest()
    await #expect(throws: AVFoundationDriverError.self) { try await asking.value }
    #expect(system.catalogueConfigurations == 0)
    #expect(try preparation.read()["microphone"] is NSNull)
  }

  @Test func backgroundAndNewCaptureOwnershipFencePendingAccess() async throws {
    for backgrounded in [false, true] {
      let system = PreparationSystem(permission: .notDetermined, suspendRequest: true)
      let preparation = MicrophoneAccessPreparation(system: system)
      _ = try preparation.begin(requireIdle: { if !system.isIdle { throw AVFoundationDriverError.operationFailed } })
      let asking = Task { @MainActor in _ = try await preparation.requestRecordingAccess() }
      defer { preparation.end(); system.finishFixture(); asking.cancel() }
      try await system.waitForRequest()
      if backgrounded { system.isForeground = false } else { system.isIdle = false }
      system.completeRequest()
      await #expect(throws: AVFoundationDriverError.self) { try await asking.value }
      #expect(system.catalogueConfigurations == 0)
    }
  }

  @Test func duplicateAccessActionAndUnadvertisedInputAreRejected() async throws {
    let system = PreparationSystem(permission: .notDetermined, suspendRequest: true)
    let preparation = MicrophoneAccessPreparation(system: system)
    _ = try preparation.begin(requireIdle: {})
    let asking = Task { @MainActor in _ = try await preparation.requestRecordingAccess() }
    defer { preparation.end(); system.finishFixture(); asking.cancel() }
    try await system.waitForRequest()
    await #expect(throws: AVFoundationDriverError.self) { _ = try await preparation.requestRecordingAccess() }
    system.completeRequest(); try await asking.value
    #expect(system.requests == 1)
    #expect(throws: AVFoundationDriverError.self) { try preparation.select(id: "not-advertised") }
  }
}

@MainActor private final class PreparationSystem: MicrophoneAccessPreparationSystem {
  var isForeground = true
  var isIdle = true, idleChecks = 0
  var permissionValue: AppleMicrophonePermissionState
  var requests = 0, catalogueConfigurations = 0
  var catalogueEmpty = false
  let suspendRequest: Bool
  var response: CheckedContinuation<Void, Never>?
  private var fixtureClosed = false
  init(permission: AppleMicrophonePermissionState, suspendRequest: Bool = false) {
    permissionValue = permission; self.suspendRequest = suspendRequest
  }
  func permission() -> AppleMicrophonePermissionState { permissionValue }
  func requestPermission() async -> AppleMicrophonePermissionState {
    guard !fixtureClosed, !Task.isCancelled else { return .unavailable }
    requests += 1
    if suspendRequest {
      await withCheckedContinuation { response = $0 }
    }
    guard !fixtureClosed, !Task.isCancelled else { return .unavailable }
    permissionValue = .granted
    return permissionValue
  }
  func configureInputCatalogue() throws { catalogueConfigurations += 1 }
  func devices() -> [AppleAudioInputDevice] {
    if catalogueEmpty { return [] }
    return [AppleAudioInputDevice(id: "synthetic-built-in", label: "Synthetic input", kind: "built_in", current: true),
      AppleAudioInputDevice(id: "synthetic-headset", label: "Synthetic headset", kind: "bluetooth", current: false)]
  }
  func waitForRequest() async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while response == nil {
      guard ContinuousClock.now < deadline else { throw PreparationFixtureError.requestNeverBegan }
      try await Task.sleep(for: .milliseconds(1))
    }
  }
  func completeRequest() { response?.resume(); response = nil }
  func finishFixture() { fixtureClosed = true; completeRequest() }
}

private enum PreparationFixtureError: Error { case requestNeverBegan }
