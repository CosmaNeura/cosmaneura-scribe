@preconcurrency import AppKit
import Testing
@testable import ScribeDesktopAudio

@MainActor
private final class ChoiceReceiver: NSObject {
    @objc func choose(_ sender: NSButton) {}
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
