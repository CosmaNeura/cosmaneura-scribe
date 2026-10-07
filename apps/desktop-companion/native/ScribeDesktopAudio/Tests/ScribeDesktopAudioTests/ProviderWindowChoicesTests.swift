@preconcurrency import AppKit
import Testing
@testable import ScribeDesktopAudio

@MainActor
private final class ChoiceReceiver: NSObject {
    var clicks = 0
    @objc func choose(_ sender: NSButton) { clicks += 1 }
}

// Construct real AppKit panels without ordering them onto the desktop, querying
// screen contents, registering a menu-bar item, requesting permissions or audio.
@Test @MainActor
func meetingPickerIsFloatingAndCenteredWithoutImplicitWindowSelection() {
    NSApplication.shared.setActivationPolicy(.prohibited)
    for frame in [NSRect(x: 0, y: 0, width: 1280, height: 780),
                  NSRect(x: -1440, y: 40, width: 1440, height: 860)] {
        let window = providerMeetingPickerPanel(listHeight: 272, visibleFrame: frame)
        defer { window.close() }
        #expect(!window.isVisible && !window.isKeyWindow)
        #expect(window.title == "Scribe · Choose a meeting window")
        #expect(window.level == .statusBar && window.isFloatingPanel)
        #expect(!window.hidesOnDeactivate)
        #expect(window.collectionBehavior.contains(.canJoinAllSpaces))
        #expect(window.collectionBehavior.contains(.fullScreenAuxiliary))
        #expect(abs(window.frame.midX - frame.midX) < 1)
        #expect(abs(window.frame.midY - frame.midY) < 1)
        #expect(frame.contains(window.frame))
        #expect(window.defaultButtonCell == nil)
        let receiver = ChoiceReceiver()
        let choices = providerWindowChoices(["Zoom — Invented meeting"], target: receiver,
                                            action: #selector(ChoiceReceiver.choose(_:)))
        #expect(receiver.clicks == 0)
        #expect(choices.buttons.allSatisfy { $0.keyEquivalent.isEmpty })
    }
}

@Test @MainActor
func compactRecordingStatusFitsBothStatesAndRetainsAnExplicitStopAction() {
    NSApplication.shared.setActivationPolicy(.prohibited)
    let receiver = ChoiceReceiver()
    let controls = providerRecordingControls(target: receiver, action: #selector(ChoiceReceiver.choose(_:)))
    let frame = NSRect(x: -1440, y: 40, width: 1440, height: 860)
    let window = providerRecordingStatusPanel(controls, visibleFrame: frame)
    defer { window.close() }
    #expect(!window.isVisible && !window.isKeyWindow)
    #expect(window.title == "Scribe recording status")
    #expect(window.styleMask.contains(.nonactivatingPanel))
    #expect(window.level == .statusBar && window.isFloatingPanel)
    #expect(!window.hidesOnDeactivate)
    #expect(window.collectionBehavior.contains(.canJoinAllSpaces))
    #expect(window.collectionBehavior.contains(.fullScreenAuxiliary))
    #expect(window.collectionBehavior.contains(.ignoresCycle))
    #expect(window.isExcludedFromWindowsMenu)
    #expect(frame.maxX - window.frame.maxX == 16)
    #expect(frame.maxY - window.frame.maxY == 16)
    #expect(frame.contains(window.frame))
    let content = window.contentView!
    for failed in [false, true, false] {
        controls.update(failed: failed)
        content.layoutSubtreeIfNeeded()
        #expect(controls.stack.fittingSize.height + 24 <= content.bounds.height)
        for view in [controls.heading, controls.source, controls.guidance, controls.stop] as [NSView] {
            #expect(content.bounds.contains(view.convert(view.bounds, to: content)))
            #expect(!view.isHidden)
        }
        #expect(controls.heading.stringValue == (failed ? "⚠ Stop unconfirmed" : "● Recording"))
        #expect(controls.source.stringValue == (failed ? "Recording may still be active." : "Audio recording active"))
        #expect(controls.guidance.stringValue == (failed ? "Keep Scribe open and retry Stop." : "Pause or resume in the main Scribe window."))
        #expect(controls.stop.title == (failed ? "Retry stop" : "Stop and upload"))
        #expect(controls.stop.target === receiver)
        #expect(controls.stop.action == #selector(ChoiceReceiver.choose(_:)))
        #expect(controls.stop.isEnabled && controls.stop.keyEquivalent.isEmpty)
        #expect(controls.heading.frame.width >= controls.heading.intrinsicContentSize.width - 1)
        #expect(controls.stop.frame.width >= controls.stop.intrinsicContentSize.width - 1)
        controls.stop.performClick(nil)
    }
    #expect(receiver.clicks == 3)
}

// Offscreen view layout only: no window, permission query, stream or microphone.
@Test @MainActor
func meetingChoicesFitTheViewportAndKeepLongListsScrollable() {
    let receiver = ChoiceReceiver()
    for (count, width) in [(1, 500), (6, 500), (64, 500), (64, 320)] {
        let labels = (0..<count).map { "Chrome — Synthetic meeting \($0)" }
        let controls = providerWindowChoices(labels, target: receiver, action: #selector(ChoiceReceiver.choose(_:)))
        let stack = NSStackView(views: [controls.scroll])
        stack.frame = NSRect(x: 0, y: 0, width: width, height: 272)
        controls.scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.layoutSubtreeIfNeeded()
        let document = controls.scroll.documentView!
        #expect(controls.scroll.contentSize.width >= CGFloat(width - 20))
        #expect(controls.buttons.map(\.title) == labels)
        #expect(document.bounds.width <= controls.scroll.contentSize.width + 1)
        #expect(document.bounds.height >= CGFloat(count * 44))
        #expect(!controls.scroll.hasHorizontalScroller)
        for button in controls.buttons {
            #expect(button.frame.width <= controls.scroll.contentSize.width + 1)
            #expect(button.frame.height >= 44)
            #expect(button.target === receiver)
            #expect(button.action == #selector(ChoiceReceiver.choose(_:)))
        }
    }
}
