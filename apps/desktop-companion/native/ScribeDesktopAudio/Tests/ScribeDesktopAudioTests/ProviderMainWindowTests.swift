import AppKit
import Testing
@testable import ScribeDesktopAudio

private let workArea = CGRect(x: -1440, y: 24, width: 1440, height: 840)
private let mainBounds = CGRect(x: -500, y: 40, width: 480, height: 360)
private func window(_ id: UInt32 = 73, owner: Int32 = 41, bounds: CGRect = mainBounds,
                    alpha: Double = 1, layer: Int = NSWindow.Level.statusBar.rawValue) -> ProviderWindowMetadata {
    ProviderWindowMetadata(id: id, owner: owner, bounds: bounds, alpha: alpha, layer: layer)
}

@Test func nativeFallbackReturnsBeforeMissingCoverageCanBeAccepted() {
    var handoff = ProviderWindowHandoff()
    #expect(handoff.reconcile(mainCovers: false, forceNative: true) == .showNative)
    #expect(handoff.reconcile(mainCovers: false, forceNative: false) == .keep)
    #expect(handoff.reconcile(mainCovers: true, forceNative: false) == .hideNative)
    #expect(handoff.reconcile(mainCovers: true, forceNative: false) == .keep)
    // Missing/stale heartbeat, an occluder, screen removal or main minimization.
    #expect(handoff.reconcile(mainCovers: false, forceNative: false) == .showNative)
    // A hidden fallback is not silently healed on subsequent verification:
    // existing native visibility validation still reports failure and stops.
    #expect(handoff.reconcile(mainCovers: false, forceNative: false) == .keep)
    #expect(handoff.reconcile(mainCovers: false, forceNative: true) == .showNative)
}

@Test func mainCoverageRequiresTheExactParentAndAnUncoveredStatusLevelWindow() {
    let check: ([ProviderWindowMetadata]) -> Bool = {
        providerMainWindowVisible(73, parent: 41, helper: 42, windows: $0, screens: [workArea])
    }
    #expect(check([window()]))
    #expect(!check([])) // hidden, minimized, closed, or not in this Space
    #expect(!check([window(owner: 99)]))
    #expect(!check([window(74)]))
    #expect(!check([window(alpha: 0.5)]))
    #expect(!check([window(layer: 0)]))
    #expect(!check([window(layer: NSWindow.Level.floating.rawValue)]))
    #expect(!check([window(layer: NSWindow.Level.statusBar.rawValue - 1)]))
    #expect(NSWindow.Level.statusBar.rawValue < NSWindow.Level.popUpMenu.rawValue)
    #expect(check([window(), window(90, owner: 99, layer: 20)])) // Dock overlay behind
    #expect(!check([window(90, owner: 99, layer: NSWindow.Level.popUpMenu.rawValue), window()]))
    #expect(!check([window(bounds: CGRect(x: 100, y: 40, width: 480, height: 360))]))
    #expect(!check([window(bounds: CGRect(x: -500, y: 40, width: 480, height: 120))]))
    #expect(!check([window(90, owner: 99), window()])) // another app is above the controls
    #expect(check([window(90, owner: 42), window()])) // own fallback can hand back
    #expect(check([window(90, owner: 99, alpha: 0), window()]))
    #expect(check([window(), window(90, owner: 99)])) // Zoom behind the controller
    #expect(!providerMainWindowVisible(73, parent: 41, helper: 42, windows: [window()], screens: []))
}

@Test @MainActor func mainCoverageExpiresWithoutRefreshAndCannotSwitchIdentity() throws {
    var now = ContinuousClock.now, owner: Int32? = 41, onscreen = true
    let lease = ProviderMainWindowLease(parent: 41, owner: { _ in owner },
                                       visible: { _, _ in onscreen }, clock: { now })
    #expect(!lease.coversRecording) // old host has no handoff and uses native UI
    try lease.refresh(73)
    #expect(lease.coversRecording)
    now = now.advanced(by: .milliseconds(2499))
    #expect(lease.coversRecording)
    now = now.advanced(by: .milliseconds(1))
    #expect(!lease.coversRecording) // hung main cannot keep a stale offer alive
    try lease.refresh(73)
    #expect(lease.coversRecording)
    onscreen = false; #expect(!lease.coversRecording)
    onscreen = true; owner = 99; #expect(!lease.coversRecording)
    #expect(throws: ProviderPresentationFailure.self) { try lease.refresh(73) }
    owner = 41
    #expect(throws: ProviderPresentationFailure.self) { try lease.refresh(74) }
    try lease.refresh(nil)
    #expect(!lease.coversRecording)
    try lease.refresh(73)
    #expect(lease.coversRecording)
}

@Test func mainWindowProtocolIsOptInAndRejectsRendererAttestationOrForeignIdentityFields() throws {
    func command(_ fields: [String: Any]) throws -> Data {
        var data = Data([1]); data.append(try JSONSerialization.data(withJSONObject: fields)); return data
    }
    let valid = try command(["type": "primaryWindow", "request": 1, "windowID": 73])
    #expect(throws: ProviderPresentationFailure.self) { try PresentationCommand.parse(valid) }
    if case .primaryWindow(1, 73) = try PresentationCommand.parse(valid, protocolVersion: 2) {} else {
        Issue.record("The exact main-owned identifier was not parsed")
    }
    for fields: [String: Any] in [
        ["type": "primaryWindow", "request": 1, "windowID": true],
        ["type": "primaryWindow", "request": 1, "windowID": 0],
        ["type": "primaryWindow", "request": 1, "windowID": 4294967296],
        ["type": "primaryWindow", "request": 1, "windowID": 73, "visible": true],
        ["type": "primaryWindow", "request": 1, "windowID": 73, "parentPID": 41],
        ["type": "primaryWindow", "request": true, "windowID": 73],
    ] {
        let data = try command(fields)
        #expect(throws: ProviderPresentationFailure.self) { try PresentationCommand.parse(data, protocolVersion: 2) }
    }
}
