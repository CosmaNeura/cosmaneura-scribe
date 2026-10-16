import Foundation
import Testing
@testable import ScribeDesktopAudio

@MainActor
private final class InlineSurface: ProviderPresentationSurface {
    var onEvent: (@MainActor (ProviderPresentationEvent) -> Void)?
    var discoveries = 0
    var choices = 0
    var failure: ProviderPresentationFailure?
    func meetingWindows() async throws -> [ProviderMeetingWindow] {
        discoveries += 1
        if let failure { throw failure }
        return try (1...64).map { index in
            ProviderMeetingWindow(selection: try MeetingAudioSelection(application: .zoom, processID: 42, windowID: UInt32(index)),
                                  title: "Zoom — Synthetic visit \(index)")
        }
    }
    func choose() async throws -> MeetingAudioSelection { choices += 1; throw ProviderPresentationFailure.unavailable }
    func publish(_ state: ProviderRecordingPresentation) throws {}
    func verifyVisibility() {}
}

@Test(arguments: [ProviderPresentationFailure.screenAccessDenied, .windowDiscoveryFailed, .windowLimitExceeded])
@MainActor
func inlineWindowFailureUsesOnlyBoundedDiagnosticCodes(_ failure: ProviderPresentationFailure) async throws {
    let input = Pipe(), output = Pipe(), surface = InlineSurface(), reader = InlinePipeReader(output.fileHandleForReading)
    surface.failure = failure
    func send(_ type: String, _ request: Int) throws {
        let bytes = try JSONSerialization.data(withJSONObject: ["type": type, "request": request]), length = bytes.count + 1
        var frame = Data([UInt8((length >> 24) & 255), UInt8((length >> 16) & 255), UInt8((length >> 8) & 255), UInt8(length & 255), 1])
        frame.append(bytes); try input.fileHandleForWriting.write(contentsOf: frame)
    }
    let host = Task { await ProviderPresentationProcess.run(surface: surface, input: input.fileHandleForReading,
                                                           output: output.fileHandleForWriting, protocolVersion: 3) }
    #expect(try await Task.detached { try reader.read()["version"] as? Int }.value == 3)
    try send("windows", 1)
    let result = try await Task.detached {
        let row = try reader.read()
        return (row.keys.sorted(), row["type"] as? String, row["request"] as? Int, row["diagnostic"] as? String)
    }.value
    #expect(result.0 == ["diagnostic", "request", "type"])
    #expect(result.1 == "unavailable" && result.2 == 1)
    #expect(result.3 == failure.windowDiscoveryDiagnostic)
    #expect(surface.discoveries == 1 && surface.choices == 0)
    try send("close", 2)
    #expect(try await Task.detached { try reader.read()["type"] as? String }.value == "closed")
    #expect(await host.value == 0)
    try input.fileHandleForWriting.close()
}

private final class InlinePipeReader: @unchecked Sendable {
    let handle: FileHandle
    init(_ handle: FileHandle) { self.handle = handle }
    func read() throws -> [String: Any] {
        func exact(_ count: Int) throws -> Data {
            var data = Data()
            while data.count < count {
                guard let part = try handle.read(upToCount: count - data.count), !part.isEmpty else { throw ProviderPresentationFailure.unavailable }
                data.append(part)
            }
            return data
        }
        let header = try exact(4), length = header.reduce(0) { $0 * 256 + Int($1) }
        guard (2...2048).contains(length) else { throw ProviderPresentationFailure.unavailable }
        let data = try exact(length)
        guard data.first == 1, let result = try JSONSerialization.jsonObject(with: data.dropFirst()) as? [String: Any] else {
            throw ProviderPresentationFailure.unavailable
        }
        return result
    }
    func readList() throws -> [String] {
        var titles: [String] = []
        while true {
            let row = try read()
            if row["type"] as? String == "windows" {
                guard row["count"] as? Int == titles.count else { throw ProviderPresentationFailure.unavailable }
                return titles
            }
            guard row["type"] as? String == "window", row["request"] as? Int == 1, let title = row["title"] as? String else {
                throw ProviderPresentationFailure.unavailable
            }
            titles.append(title)
        }
    }
}

@Test @MainActor
func inlineMetadataUsesTheActualPipeWithoutOpeningAChooserOrAudio() async throws {
    let input = Pipe(), output = Pipe(), surface = InlineSurface(), reader = InlinePipeReader(output.fileHandleForReading)
    func send(_ type: String, _ request: Int) throws {
        let bytes = try JSONSerialization.data(withJSONObject: ["type": type, "request": request]), length = bytes.count + 1
        var frame = Data([UInt8((length >> 24) & 255), UInt8((length >> 16) & 255), UInt8((length >> 8) & 255), UInt8(length & 255), 1])
        frame.append(bytes); try input.fileHandleForWriting.write(contentsOf: frame)
    }
    let host = Task { await ProviderPresentationProcess.run(surface: surface, input: input.fileHandleForReading,
                                                           output: output.fileHandleForWriting, protocolVersion: 3) }
    let version = try await Task.detached { try reader.read()["version"] as? Int }.value
    #expect(version == 3)
    try send("windows", 1)
    let titles = try await Task.detached { try reader.readList() }.value
    #expect(titles.count == 64 && titles.first == "Zoom — Synthetic visit 1")
    #expect(surface.discoveries == 1 && surface.choices == 0)
    try send("close", 2)
    let closed = try await Task.detached { try reader.read()["type"] as? String }.value
    #expect(closed == "closed")
    #expect(await host.value == 0)
    try input.fileHandleForWriting.close()
}
