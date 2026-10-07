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
    private var start: NSButton?
    private var selectedIndex: Int?
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
                let window = providerMeetingPickerPanel(listHeight: listHeight, visibleFrame: NSScreen.main?.visibleFrame)
                panel = window; window.delegate = self
                let controls = providerWindowChoices(rows.map(\.1), target: self, action: #selector(selectRow(_:)))
                choices = controls.buttons
                let scroll = controls.scroll
                let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancelSelection(_:)))
                cancel = cancelButton; cancelButton.keyEquivalent = "\u{1b}"
                let startButton = NSButton(title: "Start recording", target: self, action: #selector(confirmSelection(_:)))
                start = startButton; startButton.isEnabled = false
                let actions = NSStackView(views: [cancelButton, startButton])
                actions.orientation = .horizontal; actions.spacing = 12
                let disclosure = NSTextField(wrappingLabelWithString:
                    "Select the window for this visit, then choose Start recording. Scribe records your microphone and all audio from that application. Close unrelated audio in Chrome, including other tabs and windows.")
                let stack = NSStackView(views: [disclosure, scroll, actions])
                stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
                scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
                install(stack, in: window)
                window.initialFirstResponder = choices.first
                window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
                if !window.isVisible { finish(.failure(ProviderPresentationFailure.unavailable), attempt: attempt) }
            }
        } onCancel: { [weak self] in
            Task { @MainActor in self?.finish(.failure(ProviderPresentationFailure.cancelled), attempt: attempt) }
        }
        try Task.checkCancellation()
        return selection
    }

    /// A second request only reveals this same pending picker. It never reruns
    /// discovery, selects a row, or creates a new capture request.
    public func showWindowChooser() throws {
        guard choosing, continuation != nil, requestID != nil, let panel else {
            throw ProviderPresentationFailure.unavailable
        }
        panel.deminiaturize(nil)
        panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        guard panel.isVisible else { throw ProviderPresentationFailure.unavailable }
    }

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === panel, let requestID { finish(.failure(ProviderPresentationFailure.cancelled), attempt: requestID) }
        return false
    }
    @objc private func cancelSelection(_ sender: NSButton) {
        guard sender === cancel, let requestID else { return }
        finish(.failure(ProviderPresentationFailure.cancelled), attempt: requestID)
    }
    @objc private func selectRow(_ sender: NSButton) {
        guard continuation != nil, let index = choices.firstIndex(where: { $0 === sender }) else { return }
        selectedIndex = index
        for button in choices { button.state = button === sender ? .on : .off }
        start?.isEnabled = true
    }
    @objc private func confirmSelection(_ sender: NSButton) {
        guard sender === start, let requestID, let index = selectedIndex, index < selections.count else { return }
        finish(.success(selections[index]), attempt: requestID)
    }
    private func finish(_ result: Result<MeetingAudioSelection, any Error>, attempt: UUID) {
        guard requestID == attempt, let pending = continuation else { return }
        continuation = nil
        panel?.delegate = nil; panel?.close(); panel = nil
        choices.removeAll(); cancel = nil; start = nil; selectedIndex = nil; selections.removeAll()
        pending.resume(with: result)
    }
}

/// Construction stays separate from showing UI so AppKit geometry, focus and
/// Space behavior can be checked with a hidden panel and invented labels.
@MainActor
func providerMeetingPickerPanel(listHeight: Int, visibleFrame: NSRect?) -> NSPanel {
    let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 540, height: listHeight + 200),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Scribe · Choose a meeting window"
    window.isReleasedWhenClosed = false; window.hidesOnDeactivate = false
    window.isFloatingPanel = true; window.level = .statusBar
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    if let visibleFrame {
        window.setFrameOrigin(NSPoint(x: visibleFrame.midX - window.frame.width / 2,
                                      y: visibleFrame.midY - window.frame.height / 2))
    } else { window.center() }
    return window
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
        button.setButtonType(.radio)
        button.alignment = .left; button.bezelStyle = .rounded
        button.lineBreakMode = .byTruncatingTail; button.toolTip = label
        button.setAccessibilityHelp("Select this window. Recording starts only after choosing Start recording.")
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
    private var controls: ProviderRecordingControls?
    private let mainWindow = ProviderMainWindowLease.system()
    private var handoff = ProviderWindowHandoff()
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
            panel?.delegate = nil; panel?.close(); panel = nil; controls = nil
            if let status { NSStatusBar.system.removeStatusItem(status) }
            status = nil; stopMenuItem = nil
            state = next; notified = false; return
        }
        let firstPresentation = panel == nil
        let enteringFailure: Bool
        if case .failed = next { enteringFailure = next != state } else { enteringFailure = false }
        state = next
        if panel == nil {
            let content = providerRecordingControls(target: self, action: #selector(stopRequested(_:)))
            let window = providerRecordingStatusPanel(content, visibleFrame: NSScreen.main?.visibleFrame)
            controls = content; panel = window; window.delegate = self
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength); status = item
            let actions = NSMenu()
            let action = NSMenuItem(title: "Stop and upload", action: #selector(stopRequested(_:)), keyEquivalent: "")
            stopMenuItem = action
            action.target = self; actions.addItem(action); item.menu = actions
            screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                     object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.verifyVisibility() }
            }
        }
        updateLabels()
        // A status update must not repeatedly raise a competing window. The
        // first indicator and a new stop failure still demand visible awareness.
        reconcileSurface(front: firstPresentation || enteringFailure)
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
    public func refreshMainWindow(_ windowID: UInt32?) throws {
        try mainWindow.refresh(windowID)
        verifyVisibility()
    }
    public func verifyVisibility() {
        guard state.session != nil else { return }
        reconcileSurface()
        if !visible { reportVisibilityLoss() }
    }
    private var usesMainWindow: Bool {
        if case .recording = state { return mainWindow.coversRecording }
        return false // A failed stop always retains independent native controls.
    }
    private func reconcileSurface(front: Bool = false) {
        guard state.session != nil, let panel else { return }
        switch handoff.reconcile(mainCovers: usesMainWindow, forceNative: front) {
        case .keep: break
        case .hideNative: panel.orderOut(nil)
        case .showNative:
            if !NSScreen.screens.contains(where: { $0.visibleFrame.contains(panel.frame) }),
               let frame = NSScreen.main?.visibleFrame {
                panel.setFrameOrigin(NSPoint(x: max(frame.minX, frame.maxX - panel.frame.width - 16),
                                             y: max(frame.minY, frame.maxY - panel.frame.height - 16)))
            }
            panel.orderFrontRegardless()
        }
    }
    private var visible: Bool {
        guard status?.button != nil else { return false }
        if usesMainWindow { return true }
        guard let panel, panel.isVisible, !panel.isMiniaturized else { return false }
        return NSScreen.screens.contains { $0.frame.intersects(panel.frame) }
    }
    @objc private func stopRequested(_ sender: AnyObject) {
        guard sender === controls?.stop || sender === stopMenuItem, let session = state.session else { return }
        requestStop(session)
    }
    private func reportVisibilityLoss() {
        guard let session = state.session, !notified else { return }
        notified = true; state = .failed(session); updateLabels()
        reconcileSurface(front: true); visibilityLost(session)
    }
    private func updateLabels() {
        let failed: Bool
        if case .failed = state { failed = true } else { failed = false }
        controls?.update(failed: failed)
        stopMenuItem?.title = failed ? "Retry stop" : "Stop and upload"
        status?.button?.title = failed ? "⚠ Scribe stop unconfirmed" : "● Scribe recording"
    }
}

@MainActor
struct ProviderRecordingControls {
    let stack: NSStackView
    let heading: NSTextField
    let source: NSTextField
    let guidance: NSTextField
    let stop: NSButton

    func update(failed: Bool) {
        heading.stringValue = failed ? "⚠ Stop unconfirmed" : "● Recording"
        source.stringValue = failed ? "Recording may still be active." : "Audio recording active"
        guidance.stringValue = failed ? "Keep Scribe open and retry Stop." : "Pause or resume in the main Scribe window."
        stop.title = failed ? "Retry stop" : "Stop and upload"
    }
}

@MainActor
func providerRecordingControls(target: AnyObject, action: Selector) -> ProviderRecordingControls {
    let heading = NSTextField(labelWithString: "")
    heading.font = .boldSystemFont(ofSize: 13)
    let source = NSTextField(wrappingLabelWithString: "")
    let guidance = NSTextField(wrappingLabelWithString: "")
    source.font = .systemFont(ofSize: 11); guidance.font = .systemFont(ofSize: 11)
    let stop = NSButton(title: "Stop and upload", target: target, action: action)
    let row = NSStackView(views: [heading, stop])
    row.orientation = .horizontal; row.spacing = 8; row.alignment = .centerY
    let stack = NSStackView(views: [row, source, guidance])
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
    row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    source.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    guidance.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    let controls = ProviderRecordingControls(stack: stack, heading: heading, source: source, guidance: guidance, stop: stop)
    controls.update(failed: false)
    return controls
}

@MainActor
func providerRecordingStatusPanel(_ controls: ProviderRecordingControls, visibleFrame: NSRect?) -> NSPanel {
    let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 104),
                         styleMask: [.titled, .utilityWindow, .nonactivatingPanel], backing: .buffered, defer: false)
    window.title = "Scribe recording status"
    window.isReleasedWhenClosed = false; window.hidesOnDeactivate = false
    window.isFloatingPanel = true; window.level = .statusBar
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    window.isExcludedFromWindowsMenu = true
    install(controls.stack, in: window, inset: 12)
    if let visibleFrame {
        window.setFrameOrigin(NSPoint(x: max(visibleFrame.minX, visibleFrame.maxX - window.frame.width - 16),
                                      y: max(visibleFrame.minY, visibleFrame.maxY - window.frame.height - 16)))
    } else { window.center() }
    return window
}

@MainActor
private func install(_ stack: NSStackView, in window: NSWindow, inset: CGFloat = 20) {
    guard let content = window.contentView else { return }
    stack.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(stack)
    NSLayoutConstraint.activate([
        stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: inset),
        stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -inset),
        stack.topAnchor.constraint(equalTo: content.topAnchor, constant: inset),
        stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -inset),
    ])
}
