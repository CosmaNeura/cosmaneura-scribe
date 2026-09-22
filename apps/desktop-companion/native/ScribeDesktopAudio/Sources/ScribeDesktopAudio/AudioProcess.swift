import Foundation

public protocol DesktopProcessSource: Sendable {
    func start(selection: MeetingAudioSelection, maximumDurationSeconds: Int, sink: any DesktopAudioSink) async throws
    func stop(mode: DesktopAudioStopMode) async throws
}
extension MacMeetingAudio: DesktopProcessSource {}

/// Dedicated child-process entry only. The executable must exit when run returns:
/// an uncooperative native stop is bounded by process termination on parent loss.
/// Do not embed this runner in the desktop app's own process.
public enum DesktopAudioProcess {
    public static func run(source: any DesktopProcessSource, input: FileHandle = .standardInput,
                           output: FileHandle = .standardOutput) async -> Int32 {
        let done = ProcessCompletion(), writer = ProcessOutput(output)
        let host = AudioProcessHost(source: source, output: writer, done: done)
        let reader = ProcessInput(input)
        Task.detached {
            do {
                while let command = try reader.next() { await host.accept(command) }
                await host.disconnect()
            } catch { await host.disconnect() }
        }
        Task {
            while !done.isComplete {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                await host.checkParent()
            }
        }
        return await done.wait()
    }

    public static func writeAvailability(_ available: Bool, output: FileHandle = .standardOutput) async {
        let writer = ProcessOutput(output)
        writer.metadata(["type": "availability", "available": available])
        await writer.drain()
    }
}

private final class ProcessCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Int32?
    private var waiter: CheckedContinuation<Int32, Never>?
    var isComplete: Bool { lock.withLock { result != nil } }
    func finish(_ code: Int32) {
        lock.withLock {
            guard result == nil else { return }
            result = code; waiter?.resume(returning: code); waiter = nil
        }
    }
    func wait() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.withLock {
                if let result { continuation.resume(returning: result) }
                else { waiter = continuation }
            }
        }
    }
}

private struct ProcessStopAttempt: Sendable {
    let id = UUID()
    let task: Task<DesktopPCMCompletion?, Error>
}

private actor AudioProcessHost {
    private let source: any DesktopProcessSource
    private let output: ProcessOutput
    private let done: ProcessCompletion
    private var mixer: AlignedMeetingPCM?
    private var sink: ProcessPCMSink?
    private var started = false
    private var nativeReady = false
    private var discarded = false
    private var stopped = false
    private var disconnected = false
    private var failureSent = false
    private var startTask: Task<Void, Never>?
    private var discardTask: Task<Void, Error>?
    private var closing: ProcessStopAttempt?
    private var completion: DesktopPCMCompletion?
    private var requests: Set<Int> = []
    private var pendingStops = 0
    private var lastInput = ContinuousClock.now

    init(source: any DesktopProcessSource, output: ProcessOutput, done: ProcessCompletion) {
        self.source = source; self.output = output; self.done = done
    }
    func accept(_ command: ProcessCommand) {
        guard !disconnected else { return }
        lastInput = .now
        switch command {
        case .heartbeat: break
        case .start(let selection, let duration, let frames):
            guard !started, !stopped else { fail(.invalidAudio); return }
            started = true
            let nextSink = ProcessPCMSink(output: output) { [weak self] error in Task { await self?.fail(error) } }
            sink = nextSink
            do {
                let nextMixer = try AlignedMeetingPCM(maximumOutputFrames: frames, sink: nextSink)
                mixer = nextMixer
                startTask = Task {
                    do {
                        try await source.start(selection: selection, maximumDurationSeconds: duration, sink: nextMixer)
                        guard !discarded, !stopped, !disconnected else { return }
                        nativeReady = true; nextSink.nativeStarted()
                    } catch {
                        if !discarded, !stopped, !disconnected { fail((error as? DesktopAudioFailure) ?? .unavailable) }
                    }
                }
            } catch { fail(.invalidAudio) }
        case .activate:
            guard nativeReady, !stopped, sink?.activate() == true else { fail(.invalidAudio); return }
        case .acknowledge(let frame):
            guard sink?.acknowledge(frame) == true else { fail(.invalidAudio); return }
        case .stop(let request, let mode): stop(request: request, mode: mode)
        }
    }

    private func stop(request: Int, mode: DesktopAudioStopMode) {
        guard !requests.contains(request), requests.count < 32, pendingStops < 4 else { fail(.invalidAudio); return }
        requests.insert(request)
        if stopped {
            output.metadata(["type": "stopped", "request": request,
                             "completion": mode == .drain ? completion?.wireValue as Any? ?? NSNull() : NSNull()])
            return
        }
        if mode == .discard || !nativeReady { requestDiscard() }
        let attempt: ProcessStopAttempt
        if let closing { attempt = closing }
        else {
            attempt = ProcessStopAttempt(task: Task { try await self.closeNative() })
            closing = attempt
        }
        pendingStops += 1
        Task {
            defer { pendingStops -= 1 }
            do {
                let result = try await attempt.task.value
                stopped = true; completion = discarded ? nil : result
                if closing?.id == attempt.id { closing = nil }
                output.metadata(["type": "stopped", "request": request,
                                 "completion": completion?.wireValue as Any? ?? NSNull()])
            } catch {
                if closing?.id == attempt.id { closing = nil; discardTask = nil }
                output.metadata(["type": "stopFailed", "request": request])
            }
        }
    }

    private func closeNative() async throws -> DesktopPCMCompletion? {
        do { try await source.stop(mode: discarded ? .discard : .drain) }
        catch {
            if discarded, let discardTask { try await discardTask.value }
            else { throw error }
        }
        if discarded {
            if let discardTask { try await discardTask.value }
            return nil
        }
        guard let sink, let mixer else { return nil }
        do {
            // Free acknowledged output capacity before emitting the final mixed
            // tail; native callbacks have already stopped and drained above.
            try await sink.drain()
            if discarded { return nil }
            let result = try mixer.finish()
            try await sink.drain()
            return discarded ? nil : result
        } catch {
            if discarded { return nil }
            throw error
        }
    }

    private func requestDiscard() {
        discarded = true; startTask?.cancel(); sink?.discard(); mixer?.discard()
        if discardTask == nil { discardTask = Task { try await source.stop(mode: .discard) } }
    }
    private func fail(_ reason: DesktopAudioFailure) {
        guard !failureSent, !disconnected, !stopped else { return }
        failureSent = true; requestDiscard()
        let code: String
        switch reason {
        case .permissionRequired: code = "permission_required"
        case .inputChanged, .selectionChanged: code = "device_changed"
        case .clockDiscontinuity: code = "clock_discontinuity"
        case .bufferOverflow: code = "overflow"
        default: code = "failed"
        }
        output.metadata(["type": "failure", "code": code])
    }

    func checkParent() {
        if ContinuousClock.now - lastInput > .seconds(15) || !output.isValid { disconnect() }
    }
    func disconnect() {
        guard !disconnected else { return }
        disconnected = true
        let wasStopped = stopped
        requestDiscard(); output.invalidate()
        let done = done, source = source
        Task {
            do { try await source.stop(mode: .discard); done.finish(wasStopped ? 0 : 1) }
            catch { done.finish(1) }
        }
        Task {
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            done.finish(1) // Dedicated executable exits even if OS stop is stuck.
        }
    }
}
