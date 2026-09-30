@preconcurrency import AppKit
@preconcurrency import ScreenCaptureKit
import Foundation

public enum ProviderPresentationFailure: Error, Sendable {
    case disabled, unavailable, cancelled, busy, invalidTransition
}

/// A deliberate native window choice for the existing macOS 14.2 capture source.
/// The trusted host invokes this only from its authorized Start path. It does
/// not request permission, start a stream, capture a screenshot, or log titles.
@MainActor
public final class MacProviderWindowPicker: NSObject, NSWindowDelegate {
    private let enabled: Bool
    private var choosing = false
    private var panel: NSPanel?
    private var choices: [NSButton] = []
    private var cancel: NSButton?
    private var requestID: UUID?
    private var selections: [MeetingAudioSelection] = []
    private var continuation: CheckedContinuation<MeetingAudioSelection, any Error>?

    public init(enabled: Bool = false) { self.enabled = enabled; super.init() }

    public func choose() async throws -> MeetingAudioSelection {
        guard enabled else { throw ProviderPresentationFailure.disabled }
        guard !choosing else { throw ProviderPresentationFailure.busy }
        guard NSApp != nil, MacMeetingAudio.permissionsGranted() else { throw ProviderPresentationFailure.unavailable }
        choosing = true
        defer { choosing = false; requestID = nil }
        try Task.checkCancellation()
        let rows: [(MeetingAudioSelection, String)]
        do {
            rows = try await ProviderWindowDiscovery<[(MeetingAudioSelection, String)]>().load {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                try Task.checkCancellation()
                return content.windows.compactMap { window -> (MeetingAudioSelection, String)? in
                    guard let owner = window.owningApplication,
                          let app = MeetingAudioSelection.Application(rawValue: owner.bundleIdentifier),
                          let selection = try? MeetingAudioSelection(application: app, processID: owner.processID, windowID: window.windowID) else { return nil }
                    let title = String((window.title ?? "Untitled window").prefix(256))
                    return (selection, (app == .chrome ? "Chrome — " : "Zoom — ") + title)
                }.sorted { $0.0.windowID < $1.0.windowID }
            }
        } catch { throw ProviderPresentationFailure.unavailable }
        try Task.checkCancellation()
        guard !rows.isEmpty, rows.count <= 64 else { throw ProviderPresentationFailure.unavailable }
        let attempt = UUID()
        requestID = attempt
        let selection: MeetingAudioSelection = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { pending in
                continuation = pending
                selections = rows.map(\.0)
                let listHeight = min(272, rows.count * 52 - 8)
                let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 540, height: listHeight + 180),
                                     styleMask: [.titled, .closable], backing: .buffered, defer: false)
                panel = window; window.title = "Choose a meeting window"; window.delegate = self
                window.isReleasedWhenClosed = false; window.hidesOnDeactivate = false
                let controls = providerWindowChoices(rows.map(\.1), target: self, action: #selector(confirmSelection(_:)))
                choices = controls.buttons
                let scroll = controls.scroll
                let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancelSelection(_:)))
                cancel = cancelButton; cancelButton.keyEquivalent = "\u{1b}"
                let disclosure = NSTextField(wrappingLabelWithString:
                    "Choose a window to start recording your microphone and application audio. Chrome audio can include other tabs or windows. Window selection does not isolate one browser tab.")
                let stack = NSStackView(views: [disclosure, scroll, cancelButton])
                stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
                scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
                install(stack, in: window)
                window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
                if !window.isVisible { finish(.failure(ProviderPresentationFailure.unavailable), attempt: attempt) }
            }
        } onCancel: { [weak self] in
            Task { @MainActor in self?.finish(.failure(ProviderPresentationFailure.cancelled), attempt: attempt) }
        }
        try Task.checkCancellation()
        return selection
    }

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === panel, let requestID { finish(.failure(ProviderPresentationFailure.cancelled), attempt: requestID) }
        return false
    }
    @objc private func cancelSelection(_ sender: NSButton) {
        guard sender === cancel, let requestID else { return }
        finish(.failure(ProviderPresentationFailure.cancelled), attempt: requestID)
    }
    @objc private func confirmSelection(_ sender: NSButton) {
        guard let requestID, let index = choices.firstIndex(where: { $0 === sender }),
              index < selections.count else { return }
        finish(.success(selections[index]), attempt: requestID)
    }
    private func finish(_ result: Result<MeetingAudioSelection, any Error>, attempt: UUID) {
        guard requestID == attempt, let pending = continuation else { return }
        continuation = nil
        panel?.delegate = nil; panel?.close(); panel = nil
        choices.removeAll(); cancel = nil; selections.removeAll()
        pending.resume(with: result)
    }
}

@MainActor
func providerWindowChoices(_ labels: [String], target: AnyObject, action: Selector) -> (scroll: NSScrollView, buttons: [NSButton]) {
    let listHeight = min(272, labels.count * 52 - 8)
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 500, height: listHeight))
    scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false
    scroll.autohidesScrollers = true; scroll.drawsBackground = false
    // Match the initial clip width before autoresizing; a zero-width scroll
    // view otherwise adds its entire first layout width to the document.
    let list = MeetingWindowChoices(frame: NSRect(x: 0, y: 0, width: scroll.contentSize.width, height: CGFloat(labels.count * 52 - 8)))
    list.orientation = .vertical; list.alignment = .leading; list.spacing = 8
    list.autoresizingMask = [.width]
    let buttons = labels.map { label in
        let button = NSButton(title: label, target: target, action: action)
        button.alignment = .left; button.bezelStyle = .rounded
        button.lineBreakMode = .byTruncatingTail; button.toolTip = label
        button.setAccessibilityHelp("Start recording this meeting window and your microphone.")
        list.addArrangedSubview(button)
        button.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        button.heightAnchor.constraint(equalToConstant: 44).isActive = true
        return button
    }
    scroll.documentView = list
    scroll.heightAnchor.constraint(equalToConstant: CGFloat(listHeight)).isActive = true
    return (scroll, buttons)
}

@MainActor
private final class MeetingWindowChoices: NSStackView {
    override var isFlipped: Bool { true }
}

public enum ProviderRecordingPresentation: Sendable, Equatable {
    case inactive
    case recording(UUID)
    case failed(UUID)

    var session: UUID? {
        switch self { case .inactive: nil; case .recording(let id), .failed(let id): id }
    }
}

/// Native menu-bar and persistent window presentation. Only the trusted owner
/// publishes inactive, after its source stop is confirmed. Stop/close requests
/// never hide the indicator or claim that capture has stopped.
@MainActor
public final class MacProviderRecordingIndicator: NSObject, NSWindowDelegate {
    private let enabled: Bool
    private let requestStop: @MainActor (UUID) -> Void
    private let visibilityLost: @MainActor (UUID) -> Void
    private var state: ProviderRecordingPresentation = .inactive
    private var panel: NSPanel?
    private var status: NSStatusItem?
    private var label: NSTextField?
    private var stopButton: NSButton?
    private var stopMenuItem: NSMenuItem?
    private var screenObserver: NSObjectProtocol?
    private var notified = false

    public init(enabled: Bool = false, requestStop: @escaping @MainActor (UUID) -> Void,
                visibilityLost: @escaping @MainActor (UUID) -> Void) {
        self.enabled = enabled; self.requestStop = requestStop; self.visibilityLost = visibilityLost
        super.init()
    }

    public func publish(_ next: ProviderRecordingPresentation) throws {
        guard enabled else { throw ProviderPresentationFailure.disabled }
        guard NSApp != nil else { throw ProviderPresentationFailure.unavailable }
        if let prior = state.session, let incoming = next.session, prior != incoming {
            throw ProviderPresentationFailure.invalidTransition
        }
        if case .failed = state, case .recording = next { throw ProviderPresentationFailure.invalidTransition }
        if next == .inactive {
            if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
            screenObserver = nil
            panel?.delegate = nil; panel?.close(); panel = nil; label = nil
            if let status { NSStatusBar.system.removeStatusItem(status) }
            status = nil; stopButton = nil; stopMenuItem = nil
            state = next; notified = false; return
        }
        state = next
        if panel == nil {
            let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 125),
                                 styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
            panel = window; window.title = "Scribe capture"; window.delegate = self
            window.isReleasedWhenClosed = false; window.hidesOnDeactivate = false
            window.level = .floating; window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let message = NSTextField(wrappingLabelWithString: "")
            label = message
            let stop = NSButton(title: "Stop recording / retry stop", target: self, action: #selector(stopRequested(_:)))
            stopButton = stop
            let stack = NSStackView(views: [message, stop]); stack.orientation = .vertical; stack.spacing = 12
            install(stack, in: window); window.center()
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength); status = item
            let actions = NSMenu()
            let action = NSMenuItem(title: "Stop recording / retry stop", action: #selector(stopRequested(_:)), keyEquivalent: "")
            stopMenuItem = action
            action.target = self; actions.addItem(action); item.menu = actions
            screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                     object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.verifyVisibility() }
            }
        }
        updateLabels()
        panel?.orderFrontRegardless()
        guard visible else {
            reportVisibilityLoss(); throw ProviderPresentationFailure.unavailable
        }
    }

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === panel, let session = state.session { requestStop(session) }
        return false
    }
    public func windowDidMiniaturize(_ notification: Notification) { reportVisibilityLoss() }
    public func windowWillClose(_ notification: Notification) { reportVisibilityLoss() }
    /// The native host also calls this on its presentation heartbeat. A Cocoa
    /// visibility check is not physical full-screen/multi-display acceptance.
    public func verifyVisibility() { if state.session != nil && !visible { reportVisibilityLoss() } }
    private var visible: Bool {
        guard let panel, panel.isVisible, !panel.isMiniaturized, status?.button != nil else { return false }
        return NSScreen.screens.contains { $0.frame.intersects(panel.frame) }
    }
    @objc private func stopRequested(_ sender: AnyObject) {
        guard sender === stopButton || sender === stopMenuItem, let session = state.session else { return }
        requestStop(session)
    }
    private func reportVisibilityLoss() {
        guard let session = state.session, !notified else { return }
        notified = true; state = .failed(session); updateLabels(); visibilityLost(session)
    }
    private func updateLabels() {
        let failed: Bool
        if case .failed = state { failed = true } else { failed = false }
        label?.stringValue = failed ? "Recording stop is unconfirmed. Keep Scribe open and retry Stop." : "Scribe is recording microphone and application audio."
        status?.button?.title = failed ? "⚠ Scribe stop unconfirmed" : "● Scribe recording"
    }
}

@MainActor
private func install(_ stack: NSStackView, in window: NSWindow) {
    guard let content = window.contentView else { return }
    stack.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(stack)
    NSLayoutConstraint.activate([
        stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
        stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
        stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
        stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -20),
    ])
}
