import Foundation
import Testing
@testable import ScribeDesktopAudio

@Test @MainActor func preparationCatalogueSelectsDevicesWithoutAudioOrConsentAuthority() async throws {
    // No audio, OS permission request or recording API is used by this test.
    for authorized in [true, false] {
        let input = Pipe(), output = Pipe()
        defer { try? input.fileHandleForReading.close(); try? output.fileHandleForReading.close() }
        let commands: [[String: Any]] = [
            ["type": "selectMicrophone", "request": 1, "microphoneUID": "invented-present-input"],
            ["type": "selectMicrophone", "request": 2, "microphoneUID": "invented-missing-input"],
            ["type": "stop", "request": 3, "mode": "discard"],
        ]
        for command in commands {
            var payload = Data([1]); payload.append(try JSONSerialization.data(withJSONObject: command))
            let count = UInt32(payload.count)
            var frame = Data([UInt8(count >> 24), UInt8((count >> 16) & 255), UInt8((count >> 8) & 255), UInt8(count & 255)])
            frame.append(payload); try input.fileHandleForWriting.write(contentsOf: frame)
        }
        try input.fileHandleForWriting.close()
        let catalogue = MicrophoneCatalogue(devices: { [MacMicrophoneInput(uid: "invented-present-input",
            label: "Synthetic microphone", kind: "built_in", deviceID: 1)] },
            defaultUID: { "invented-present-input" }, authorized: { authorized })
        #expect(await MicrophoneCheckProcess.run(input: input.fileHandleForReading,
            output: output.fileHandleForWriting, catalogue: catalogue) == 0)
        try output.fileHandleForWriting.close()
        let data = try #require(try output.fileHandleForReading.readToEnd())
        var offset = 0, messages: [[String: Any]] = []
        while offset < data.count {
            let count = data[offset..<offset + 4].reduce(0) { $0 * 256 + Int($1) }
            #expect(data[offset + 4] == 1) // No PCM frame or live-level output.
            messages.append(try #require(try JSONSerialization.jsonObject(with: data[offset + 5..<offset + 4 + count]) as? [String: Any]))
            offset += count + 4
        }
        #expect(messages.compactMap { $0["type"] as? String } == ["input", "inputs", "selected", "selectionFailed", "checkStopped"])
        #expect(messages[1]["available"] as? Bool == authorized)
        #expect(messages[2]["uid"] as? String == "invented-present-input")
    }
}
