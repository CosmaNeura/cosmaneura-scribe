import Foundation
import Testing
@testable import ScribeDesktopAudio

@Test func renewableCommandsHaveExactBoundedMetadata() throws {
    func command(_ values: [String: Any]) throws -> Data {
        var data = Data([1]); data.append(try JSONSerialization.data(withJSONObject: values)); return data
    }
    let run = UUID().uuidString.lowercased()
    let authorization: [String: Any] = ["runId": run, "generation": 1, "expiresAtMilliseconds": 1_800_000_000_000,
        "maximumOutputFrames": 16_000, "hardMaximumOutputFrames": 10_800 * 16_000]
    let start: [String: Any] = ["type": "startRenewable", "application": "com.google.Chrome", "processID": 1,
        "windowID": 1, "authorization": authorization,
        "processFence": ["epoch": UUID().uuidString.lowercased(), "coordinatorDevice": "1", "coordinatorInode": "2",
                         "captureDevice": "1", "captureInode": "3"]]
    guard case .startRenewable(let selection, let value, _) = try ProcessCommand.parse(command(start)) else {
        Issue.record("Missing renewable command"); return
    }
    #expect(selection.processID == 1 && value.runID == run && value.generation == 1)
    guard case .extend(let request, let repeated) = try ProcessCommand.parse(command([
        "type": "extend", "request": 1, "authorization": authorization])) else {
        Issue.record("Missing extension command"); return
    }
    #expect(request == 1 && repeated == value)
    for (key, invalid) in [("generation", true as Any), ("generation", 1.5), ("expiresAtMilliseconds", 9_007_199_254_740_992),
                           ("maximumOutputFrames", 0), ("hardMaximumOutputFrames", 1), ("runId", "not-a-run")] {
        var changed = authorization; changed[key] = invalid
        #expect(throws: DesktopAudioFailure.self) {
            try ProcessCommand.parse(command(["type": "extend", "request": 1, "authorization": changed]))
        }
    }
    var extra = authorization; extra["token"] = "disallowed"
    var missing = authorization; missing.removeValue(forKey: "runId")
    for changed in [extra, missing] {
        #expect(throws: DesktopAudioFailure.self) {
            try ProcessCommand.parse(command(["type": "extend", "request": 1, "authorization": changed]))
        }
    }
    for request: Any in [0, true, 1.5, 1_000_001] {
        #expect(throws: DesktopAudioFailure.self) {
            try ProcessCommand.parse(command(["type": "extend", "request": request, "authorization": authorization]))
        }
    }
}

@Test func privateCommandsRejectBooleanAuthorityAndExtraFields() throws {
    func command(_ values: [String: Any]) throws -> Data {
        var data = Data([1]); data.append(try JSONSerialization.data(withJSONObject: values)); return data
    }
    let epoch = UUID().uuidString.lowercased()
    var start: [String: Any] = ["type": "start", "application": "com.google.Chrome", "processID": 1,
        "windowID": 1, "maximumDurationSeconds": 60, "maximumOutputFrames": 16_000,
        "processFence": ["epoch": epoch, "coordinatorDevice": "1", "coordinatorInode": "2",
                         "captureDevice": "1", "captureInode": "3"]]
    guard case .start(let selection, let duration, let frames, let fence) = try ProcessCommand.parse(command(start)) else {
        Issue.record("Missing selected source command"); return
    }
    #expect(selection.processID == 1 && duration == 60 && frames == 16_000)
    #expect(fence.epoch == epoch)
    var missingFence = start; missingFence.removeValue(forKey: "processFence")
    #expect(throws: DesktopAudioFailure.self) { try ProcessCommand.parse(command(missingFence)) }
    start["processID"] = true
    #expect(throws: DesktopAudioFailure.self) { try ProcessCommand.parse(command(start)) }
    start["processID"] = 1; start["token"] = "invented-disallowed-field"
    #expect(throws: DesktopAudioFailure.self) { try ProcessCommand.parse(command(start)) }
    #expect(throws: DesktopAudioFailure.self) { try ProcessCommand.parse(command(["type": "stop", "request": 0, "mode": "drain"])) }
    #expect(throws: DesktopAudioFailure.self) { try ProcessCommand.parse(command(["type": "ack", "firstFrame": 1.5])) }
}

@Test func privateInputBoundsLengthAndRejectsTruncation() throws {
    for bytes in [Data([255, 255, 255, 255]), Data([0, 0, 0, 10, 1, 123])] {
        let pipe = Pipe()
        try pipe.fileHandleForWriting.write(contentsOf: bytes); try pipe.fileHandleForWriting.close()
        defer { try? pipe.fileHandleForReading.close() }
        #expect(throws: DesktopAudioFailure.self) { try ProcessInput(pipe.fileHandleForReading).next() }
    }
}

@Test func pcmPipeHoldsFourPacketsAndRequiresExactAcknowledgement() async throws {
    // Explicit invented all-parties consent precedes generated audio.
    let consent = (id: UUID(), allPartiesAgreed: true)
    #expect(consent.allPartiesAgreed)
    let pipe = Pipe(), output = ProcessOutput(pipe.fileHandleForWriting)
    let sink = ProcessPCMSink(output: output, onFailure: { _ in })
    #expect(sink.started(DesktopPCMStart(hostTimeNanoseconds: 1, microphonePrerollNanoseconds: 0, systemPrerollNanoseconds: 0)))
    sink.nativeStarted()
    for i in 0..<4 {
        let packet = DesktopPCMPacket(firstFrame: i * 2, samples: [4096, -4096])
        #expect(sink.receive(packet)); packet.clear()
    }
    let overflow = DesktopPCMPacket(firstFrame: 8, samples: [4096])
    #expect(!sink.receive(overflow)); overflow.clear()
    #expect(!sink.acknowledge(0)) // No packet can leave before activation.
    #expect(sink.activate())
    #expect(!sink.acknowledge(2))
    #expect(sink.acknowledge(0)); #expect(sink.acknowledge(2))
    #expect(sink.acknowledge(4)); #expect(sink.acknowledge(6))
    try await sink.drain(); await output.drain()
    try pipe.fileHandleForWriting.close()
    var data = try #require(try pipe.fileHandleForReading.readToEnd())
    defer { data.resetBytes(in: 0..<data.count); try? pipe.fileHandleForReading.close() }
    var kinds: [UInt8] = []
    var offset = 0
    while offset < data.count {
        let length = data[offset..<(offset + 4)].reduce(0) { $0 * 256 + Int($1) }
        kinds.append(data[offset + 4]); offset += length + 4
    }
    #expect(kinds == [1, 2, 2, 2, 2]); #expect(offset == data.count)
    sink.discard()
}

@Test func actualInputLevelsSeparateSourcesThrottleAndRetainNoSamples() throws {
    let consent = (id: UUID(), allPartiesAgreed: true)
    #expect(consent.allPartiesAgreed)
    var meter = DesktopInputLevels(), now = ContinuousClock.now
    let microphone = try DesktopAudioFrame(channel: .microphone, sampleRate: 16_000, channels: 1,
        hostTimeNanoseconds: 1, samples: [0.25, -0.25])
    let meeting = try DesktopAudioFrame(channel: .systemAudio, sampleRate: 16_000, channels: 1,
        hostTimeNanoseconds: 1, samples: [0, 0])
    let firstValue = meter.observe(microphone, now: now)
    let first = try #require(firstValue)
    #expect(first.channel == "microphone" && first.level == 0.25 && first.sequence == 1)
    let secondValue = meter.observe(meeting, now: now)
    let second = try #require(secondValue)
    #expect(second.channel == "meetingAudio" && second.level == 0 && second.sequence == 2)
    let throttled = meter.observe(microphone, now: now.advanced(by: .milliseconds(249)))
    #expect(throttled == nil)
    microphone.clear(); meeting.clear()
    now = now.advanced(by: .milliseconds(250))
    let thirdValue = meter.observe(microphone, now: now)
    let third = try #require(thirdValue)
    #expect(third.level == 0 && third.sequence == 3) // no retained prior PCM or synthetic movement
}

@Test func inputMetadataRequiresActivationAndStopsAfterDiscard() async throws {
    let consent = (id: UUID(), allPartiesAgreed: true)
    #expect(consent.allPartiesAgreed)
    let pipe = Pipe(), output = ProcessOutput(pipe.fileHandleForWriting)
    let sink = ProcessPCMSink(output: output, onFailure: { _ in })
    let frame = try DesktopAudioFrame(channel: .microphone, sampleRate: 16_000, channels: 1,
        hostTimeNanoseconds: 1, samples: [0.125, -0.125])
    defer { frame.clear(); try? pipe.fileHandleForReading.close() }
    sink.observeInput(frame) // no output before native and mixer readiness
    #expect(sink.started(DesktopPCMStart(hostTimeNanoseconds: 1, microphonePrerollNanoseconds: 0, systemPrerollNanoseconds: 0)))
    sink.nativeStarted(); #expect(sink.activate())
    sink.observeInput(frame); sink.discard(); sink.observeInput(frame)
    await output.drain(); try pipe.fileHandleForWriting.close()
    let data = try #require(try pipe.fileHandleForReading.readToEnd())
    var index = 0, messages: [[String: Any]] = []
    while index < data.count {
        let count = data[index..<index + 4].reduce(0) { $0 * 256 + Int($1) }
        #expect(data[index + 4] == 1)
        let message = try #require(try JSONSerialization.jsonObject(with: data[index + 5..<index + 4 + count]) as? [String: Any])
        messages.append(message); index += count + 4
    }
    #expect(messages.count == 2)
    #expect(messages[0]["type"] as? String == "ready")
    #expect(messages[1]["type"] as? String == "inputSignal")
    #expect(Set(messages[1].keys) == ["type", "sequence", "channel", "level"])
    #expect(messages[1]["level"] as? Double == 0.125)
}
