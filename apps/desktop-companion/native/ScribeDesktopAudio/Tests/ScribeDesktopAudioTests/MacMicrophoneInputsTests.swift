import CoreAudio
import Testing
@testable import ScribeDesktopAudio

@Test func selectedInputLookupDoesNotReadUnrelatedDevicesOrTheirNames() throws {
    let selected: AudioDeviceID = 7, unrelated: AudioDeviceID = 8
    var reads: [String] = []
    let uid = try MacMicrophoneInputs.selectedUID(deviceID: selected,
        isAlive: { id in reads.append("alive"); #expect(id == selected); return true },
        hasInputStreams: { id in reads.append("input"); #expect(id == selected); return true },
        readUID: { id in
            reads.append("uid")
            // An unrelated input has a broken property. The selected lookup
            // must succeed without touching it or requiring a catalogue/name.
            if id == unrelated { throw DesktopAudioFailure.unavailable }
            #expect(id == selected)
            return "invented-selected-input"
        })
    #expect(uid == "invented-selected-input")
    #expect(reads == ["alive", "input", "uid"])
}

@Test func disappearedOrNonInputSelectedDeviceCannotFallBack() {
    for (id, alive, input) in [(AudioDeviceID(0), true, true), (7, false, true), (7, true, false)] {
        var uidReads = 0
        #expect(throws: DesktopAudioFailure.selectionChanged) {
            try MacMicrophoneInputs.selectedUID(deviceID: id,
                isAlive: { _ in alive }, hasInputStreams: { _ in input },
                readUID: { _ in uidReads += 1; return "invented-other-input" })
        }
        #expect(uidReads == 0)
    }
}

@Test func selectedDevicePropertyFailureCannotReturnAnAlternativeUID() {
    for failedRead in 0..<3 {
        #expect(throws: DesktopAudioFailure.unavailable) {
            try MacMicrophoneInputs.selectedUID(deviceID: 7,
                isAlive: { _ in if failedRead == 0 { throw DesktopAudioFailure.unavailable }; return true },
                hasInputStreams: { _ in if failedRead == 1 { throw DesktopAudioFailure.unavailable }; return true },
                readUID: { _ in if failedRead == 2 { throw DesktopAudioFailure.unavailable }; return "invented-selected-input" })
        }
    }
}

@Test func directSelectedDeviceUIDRetainsExistingIdentityBounds() throws {
    for invalid in ["", String(repeating: "a", count: 512), "invented\ninput", "invented\u{7f}input"] {
        #expect(throws: DesktopAudioFailure.selectionChanged) {
            try MacMicrophoneInputs.selectedUID(deviceID: 7, isAlive: { _ in true },
                hasInputStreams: { _ in true }, readUID: { _ in invalid })
        }
    }
    #expect(try MacMicrophoneInputs.selectedUID(deviceID: 7, isAlive: { _ in true },
        hasInputStreams: { _ in true }, readUID: { _ in String(repeating: "a", count: 511) }).utf8.count == 511)
}
