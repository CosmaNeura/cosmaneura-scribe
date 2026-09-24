// Separate test executable, never a product target or synthetic capture mode.
// Compile with the library sources to exercise their actual inherited-pipe host.
import Darwin
import Foundation

private actor InventedSource: DesktopProcessSource {
    private let consentID = "desktop-pipe-invented-all-parties-consent"
    private var stopped = false
    private var failFirstDrain = false
    private var uncooperativeStop = false
    private var exitOnStop = false
    func start(selection: MeetingAudioSelection, maximumDurationSeconds: Int, sink: any DesktopAudioSink) async throws {
        precondition(!consentID.isEmpty && maximumDurationSeconds > 0)
        guard !stopped else { throw DesktopAudioFailure.cancelled }
        // Model a native child dying before readiness, without generating a
        // real OS crash report or ever constructing a physical audio source.
        if selection.processID == 7 { _exit(70) }
        exitOnStop = selection.processID == 8
        failFirstDrain = selection.processID == 2
        uncooperativeStop = selection.processID == 6
        if selection.processID == 4 { try await Task.sleep(for: .seconds(10)) }
        guard !stopped, !Task.isCancelled else { throw DesktopAudioFailure.cancelled }
        for i in 0..<3 {
            for channel in [DesktopAudioChannel.microphone, .systemAudio] {
                let frame = try DesktopAudioFrame(channel: channel, sampleRate: 16_000, channels: 1,
                    hostTimeNanoseconds: 1_000_000_000 + UInt64(i * 100_000_000),
                    sourceSamplePosition: Int64(i * 1600),
                    samples: Array(repeating: channel == .microphone ? Float(0.25) : 0, count: 1600))
                let accepted = sink.receive(frame); frame.clear()
                if !accepted { throw DesktopAudioFailure.sinkRejected }
            }
        }
    }
    func stop(mode: DesktopAudioStopMode) async throws {
        if exitOnStop { _exit(70) }
        if uncooperativeStop {
            await withUnsafeContinuation { (_: UnsafeContinuation<Void, Never>) in }
        }
        if mode == .drain, failFirstDrain {
            failFirstDrain = false; throw DesktopAudioFailure.stopUnconfirmed
        }
        stopped = true
    }
}

@main private enum PipeFixture {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--availability-v1"] {
            await DesktopAudioProcess.writeAvailability(true); _exit(0)
        }
        if arguments == ["--fixture-fence-v1"] {
            do {
                // The test assembly binds this provider to one fresh private
                // directory. Retain the real coordinator for the entire run.
                let coordinator = try NativeCaptureProcessCoordinator(
                    privateDirectory: nativeDesktopFenceDirectory(), expectedAnchor: nil)
                try coordinator.allowCaptureAfterConfirmedRecovery()
                let ticket = try JSONSerialization.data(withJSONObject: coordinator.wireValue)
                FileHandle.standardOutput.write(ticket + Data([10]))
                while readLine() != nil {}
                withExtendedLifetime(coordinator) {}
                _exit(0)
            } catch { _exit(70) }
        }
        guard arguments == ["--capture-v2"] else { _exit(64) }
        let result = await DesktopAudioProcess.run(source: InventedSource())
        _exit(result)
    }
}
