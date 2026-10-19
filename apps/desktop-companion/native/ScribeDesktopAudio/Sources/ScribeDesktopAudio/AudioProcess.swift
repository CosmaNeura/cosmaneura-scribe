import Foundation

public protocol DesktopProcessSource: Sendable {
    func start(selection: MeetingAudioSelection, maximumDurationSeconds: Int, sink: any DesktopAudioSink) async throws
    func stop(mode: DesktopAudioStopMode) async throws
    func start(selection: MeetingAudioSelection, authorization: DesktopCaptureAuthorization, sink: any DesktopAudioSink) async throws
    func extend(_ authorization: DesktopCaptureAuthorization) async throws
}
extension DesktopProcessSource {
    public func start(selection: MeetingAudioSelection, authorization: DesktopCaptureAuthorization, sink: any DesktopAudioSink) async throws {
        throw DesktopAudioFailure.unavailable
    }
    public func extend(_ authorization: DesktopCaptureAuthorization) async throws { throw DesktopAudioFailure.unavailable }
}
extension MacMeetingAudio: DesktopProcessSource {}

/// Dedicated child-process entry only. The executable must exit when run returns:
/// an uncooperative native stop is bounded by process termination on parent loss.
/// Do not embed this runner in the desktop app's own process. The separately
/// sandboxed XPC audio service may reuse only code 0 after stop + reader drain;
/// every nonzero or unbounded stop terminates that dedicated role process.
public enum DesktopAudioProcess {
    public static func run(source: any DesktopProcessSource, allowsRenewal: Bool = false, input: FileHandle = .standardInput,
                           output: FileHandle = .standardOutput, lifetime: NativeProcessLifetime? = nil) async -> Int32 {
        let done = ProcessCompletion(), writer = ProcessOutput(output)
        let host = AudioProcessHost(source: source, allowsRenewal: allowsRenewal, output: writer, done: done)
        let reader = ProcessInput(input, lifetime: lifetime), inputStatus = ProcessInputStatus()
        lifetime?.onCancel { Task { await host.disconnect() } }
        let reading = Task.detached {
            do {
                while let command = try reader.next() { await host.accept(command) }
                await host.disconnect()
            } catch {
                if !(error is CancellationError && lifetime?.isCancelled == true) { inputStatus.fail() }
                await host.disconnect()
            }
        }
        let heartbeat = Task {
            while !done.isComplete {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                await host.checkParent()
            }
        }
        var result = await done.wait()
        if let lifetime {
            lifetime.finishReading()
            await reading.value
            heartbeat.cancel()
            await writer.drain()
            if inputStatus.failed || writer.didFail { result = 70 }
#if SCRIBE_MAC_APP_STORE_XPC
            // Code 0 requires acknowledged native stop plus the subsequent
            // discard stop returning successfully. Release only after both
            // descriptor readers and queued output have ceased. Failure keeps
            // the fence until the XPC role process terminates.
            if result == 0 { AudioProcessFence.shared.releaseAfterConfirmedStop() }
#endif
        }
        return result
    }

    public static func writeAvailability(_ available: Bool, output: FileHandle = .standardOutput) async {
        _ = await writeAvailabilityResult(available, output: output)
    }
    public static func writeAvailabilityResult(_ available: Bool, output: FileHandle) async -> Bool {
        let writer = ProcessOutput(output)
        writer.metadata(["type": "availability", "available": available])
        await writer.drain()
        return writer.isValid
    }
}

private final class ProcessInputStatus: @unchecked Sendable {
    private let lock = NSLock()
    private var invalid = false
    func fail() { lock.withLock { invalid = true } }
    var failed: Bool { lock.withLock { invalid } }
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
    private let allowsRenewal: Bool
    private var window: DesktopCaptureWindow?
    private var extending = false
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

    init(source: any DesktopProcessSource, allowsRenewal: Bool, output: ProcessOutput, done: ProcessCompletion) {
        self.source = source; self.allowsRenewal = allowsRenewal; self.output = output; self.done = done
    }
    func accept(_ command: ProcessCommand) {
        guard !disconnected else { return }
        lastInput = .now
        switch command {
        case .heartbeat: break
        case .selectMicrophone: fail(.invalidAudio)
        case .startRenewable(let selection, let authorization, let fence):
            guard allowsRenewal, !started, !stopped else { fail(.invalidAudio); return }
            started = true
            let nextSink = ProcessPCMSink(output: output) { [weak self] error in Task { await self?.fail(error) } }
            sink = nextSink
            do {
                window = try DesktopCaptureWindow(authorization, now: .now)
                try AudioProcessFence.shared.acquire(fence)
                let nextMixer = try AlignedMeetingPCM(maximumOutputFrames: authorization.maximumOutputFrames,
                    hardMaximumOutputFrames: authorization.hardMaximumOutputFrames, microphoneOnly: selection.application == .microphone, sink: nextSink)
                mixer = nextMixer
                startTask = Task {
                    do {
                        try await source.start(selection: selection, authorization: authorization, sink: MeteredDesktopAudioSink(downstream: nextMixer, meter: nextSink))
                        guard !discarded, !stopped, !disconnected else { return }
                        guard window?.remaining(.now) ?? .zero > .zero else { throw DesktopAudioFailure.windowExpired }
                        nativeReady = true; nextSink.nativeStarted()
                    } catch {
                        if !discarded, !stopped, !disconnected { fail((error as? DesktopAudioFailure) ?? .unavailable) }
                    }
                }
            } catch { fail(.invalidAudio) }
        case .extend(let request, let authorization): extend(request, authorization)
        case .start(let selection, let duration, let frames, let fence):
            guard !started, !stopped else { fail(.invalidAudio); return }
            started = true
            let nextSink = ProcessPCMSink(output: output) { [weak self] error in Task { await self?.fail(error) } }
            sink = nextSink
            do {
                try AudioProcessFence.shared.acquire(fence)
                let nextMixer = try AlignedMeetingPCM(maximumOutputFrames: frames, microphoneOnly: selection.application == .microphone, sink: nextSink)
                mixer = nextMixer
                startTask = Task {
                    do {
                        try await source.start(selection: selection, maximumDurationSeconds: duration, sink: MeteredDesktopAudioSink(downstream: nextMixer, meter: nextSink))
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

    private func extend(_ request: Int, _ authorization: DesktopCaptureAuthorization) {
        guard allowsRenewal, nativeReady, !stopped, !discarded, !disconnected,
              closing == nil, !extending, var next = window, let mixer else { fail(.invalidAudio); return }
        do { try next.extend(authorization, now: .now) }
        catch { fail(.invalidAudio); return }
        extending = true
        Task {
            defer { extending = false }
            do {
                // Stage the verified frame budget before the native actor can
                // deliver its first renewed callback. The source still owns
                // its existing deadline until extend succeeds; any failure or
                // concurrent stop discards this same mixer and source.
                try mixer.extend(maximumOutputFrames: authorization.maximumOutputFrames)
                try await source.extend(authorization)
                // A stop or parent loss while the source awaited cannot publish
                // a successful renewal or report that recording continued.
                guard !stopped, !discarded, !disconnected, closing == nil,
                      next.remaining(.now) > .zero else { throw DesktopAudioFailure.cancelled }
                window = next
                output.metadata(["type": "extended", "request": request, "generation": authorization.generation])
            } catch {
                if !stopped, !discarded, !disconnected { fail(.unavailable) }
            }
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
        // A source-start cancellation/stop error can return before the sink's
        // queued callback reaches this actor. Preserve its latched first reason.
        let firstReason = sink?.firstFailure ?? reason
        failureSent = true; requestDiscard()
        output.metadata(firstReason.processFailureMetadata)
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

extension DesktopAudioFailure {
    /// Existing public failure behavior plus a fixed numeric diagnostic reason.
    /// The parent also accepts the earlier metadata without this optional field.
    var processFailureMetadata: [String: Any] {
        let code: String
        switch self {
        case .permissionRequired: code = "permission_required"
        case .inputChanged, .inputChangedContext, .selectionChanged: code = "device_changed"
        case .meetingDisconnected: code = "meeting_disconnected"
        case .clockDiscontinuity: code = "clock_discontinuity"
        case .bufferOverflow: code = "overflow"
        default: code = "failed"
        }
        var metadata: [String: Any] = ["type": "failure", "code": code, "reason": diagnosticReason]
        if case .inputChangedContext(let trigger, let mismatch) = self {
            metadata["input_trigger"] = trigger.rawValue
            metadata["input_mismatch"] = Int(mismatch)
        }
        return metadata
    }
}

// Retain the lock until executable exit, including an uncooperative OS stop.
// The XPC-only exception below is invoked after confirmed stop + complete pipe
// drain. Releasing an arbitrary host/task object remains insufficient evidence.
private enum AudioProcessFence {
    static let shared = Storage()
    final class Storage: @unchecked Sendable {
        private let lock = NSLock()
        private var lease: NativeCaptureProcessLease?
#if SCRIBE_MAC_APP_STORE_XPC
        func releaseAfterConfirmedStop() { lock.withLock { lease = nil } }
#endif
        func acquire(_ ticket: NativeFenceTicket) throws {
            try lock.withLock {
                guard lease == nil else { throw NativeFenceError.unavailable }
                lease = try NativeCaptureProcessLease(privateDirectory: nativeDesktopFenceDirectory(),
                    expectedAnchor: ticket.anchor, expectedEpoch: ticket.epoch)
            }
        }
    }
}
