@preconcurrency import AVFoundation
@preconcurrency import ScreenCaptureKit
@preconcurrency import AppKit
import CoreMedia
import Foundation

public struct MeetingAudioSelection: Sendable, Equatable {
    public enum Application: String, Sendable {
        case microphone = "microphone"
        case chrome = "com.google.Chrome"
        case zoom = "us.zoom.xos"
    }
    public let application: Application
    public let processID: Int32
    public let windowID: UInt32

    public init(application: Application, processID: Int32, windowID: UInt32) throws {
        guard application == .microphone ? processID == 0 && windowID == 0 : processID > 0 && windowID > 0 else { throw DesktopAudioFailure.selectionChanged }
        self.application = application; self.processID = processID; self.windowID = windowID
    }
}

public enum DesktopAudioStopMode: Sendable { case drain, discard }

/// Dormant native producer, to be owned by the trusted desktop main process.
/// The existing controller must obtain fresh consent/lease authority and publish
/// its persistent indicator before start. This producer does not replace that
/// authority, issue grants, choose a meeting, expose IPC or write raw audio.
@available(macOS 14.2, *)
public actor MacMeetingAudio {
    private enum Phase { case idle, starting, recording, stopping, stopped, failed }
    private let enabled: Bool
    private let checkPermissions: @Sendable (Bool) -> Bool
    private var phase: Phase = .idle
    private var active: CaptureSession?

    public init(enabled: Bool = false) {
        self.enabled = enabled
        checkPermissions = { Self.permissionsGranted(microphoneOnly: $0) }
    }

    // Internal injection for denial-only tests; the public/native helper entry
    // always uses the actual macOS permission check above.
    init(enabled: Bool, checkPermissions: @escaping @Sendable () -> Bool) {
        self.enabled = enabled
        self.checkPermissions = { _ in checkPermissions() }
    }

    /// Read-only. Permission prompts belong to an explicit reviewed native UI.
    public static func permissionsGranted(microphoneOnly: Bool = false) -> Bool {
        (microphoneOnly || CGPreflightScreenCaptureAccess()) && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    /// maximumDurationSeconds must be derived by the trusted host from the
    /// current Core capture window, never from a renderer field. No renewal or
    /// automatic restart is provided by this one-window producer.
    public func start(selection: MeetingAudioSelection, maximumDurationSeconds: Int, sink: any DesktopAudioSink) async throws {
        try await start(selection: selection, maximumDurationSeconds: maximumDurationSeconds, window: nil, sink: sink)
    }

    public func start(selection: MeetingAudioSelection, authorization: DesktopCaptureAuthorization, sink: any DesktopAudioSink) async throws {
        let window = try DesktopCaptureWindowOwner(authorization)
        try await start(selection: selection, maximumDurationSeconds: 905, window: window, sink: sink)
    }

    /// Extends only the currently recording source. Never restarts it or changes
    /// the selected application, microphone, source identity or fixed hard budget.
    public func extend(_ authorization: DesktopCaptureAuthorization) throws {
        guard phase == .recording, let session = active, let window = session.window else {
            throw DesktopAudioFailure.unavailable
        }
        try window.extend(authorization)
        armRenewableDeadline(session)
    }

    private func start(selection: MeetingAudioSelection, maximumDurationSeconds: Int,
                       window: DesktopCaptureWindowOwner?, sink: any DesktopAudioSink) async throws {
        guard enabled, phase == .idle, !Task.isCancelled else { throw DesktopAudioFailure.unavailable }
        guard (1...86_400).contains(maximumDurationSeconds) else { throw DesktopAudioFailure.unavailable }
        guard checkPermissions(selection.application == .microphone) else { throw DesktopAudioFailure.permissionRequired }
        phase = .starting
        do {
            // A caller-selected window is re-resolved against current PID/bundle.
            // Never infer authority from a title, URL, frontmost app or first row.
            let selectedWindow: SCWindow?
            if selection.application == .microphone { selectedWindow = nil }
            else {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                guard phase == .starting, !Task.isCancelled else { throw DesktopAudioFailure.cancelled }
                guard let candidate = content.windows.first(where: { $0.windowID == selection.windowID }),
                      let owner = candidate.owningApplication, owner.processID == selection.processID,
                      owner.bundleIdentifier == selection.application.rawValue else { throw DesktopAudioFailure.selectionChanged }
                selectedWindow = candidate
            }
            if let window, window.remaining <= .zero { throw DesktopAudioFailure.windowExpired }
            let workspaceCenter = await MainActor.run { NSWorkspace.shared.notificationCenter }
            guard phase == .starting, !Task.isCancelled else { throw DesktopAudioFailure.cancelled }
            let delivery = AudioDelivery(sink: sink, validate: { window == nil || window!.remaining > .zero }) { [weak self] _ in
                Task { await self?.terminate() }
            }
            let output = AudioOutput(delivery: delivery)
            // SCContentFilter consults WindowServer during construction. Keep
            // that AppKit boundary on the initialized application main thread.
            let stream: SCStream? = await MainActor.run {
                guard let selectedWindow else { return nil }
                let configuration = SCStreamConfiguration()
                configuration.capturesAudio = true
                configuration.excludesCurrentProcessAudio = true
                configuration.sampleRate = 48_000; configuration.channelCount = 2
                configuration.width = 2; configuration.height = 2
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                configuration.queueDepth = 3; configuration.showsCursor = false
                return SCStream(filter: SCContentFilter(desktopIndependentWindow: selectedWindow),
                                configuration: configuration, delegate: output)
            }
            // Stop can run while this actor is suspended above. No stream has
            // started yet; do not install fresh sources after ownership ends.
            guard phase == .starting, !Task.isCancelled else { throw DesktopAudioFailure.cancelled }
            let session = CaptureSession(stream: stream, output: output, delivery: delivery, window: window)
            active = session // Own every partial setup before a fallible operation.
            if window != nil { armRenewableDeadline(session) }
            else {
                session.deadline = Task {
                    do { try await Task.sleep(for: .seconds(maximumDurationSeconds)) }
                    catch { return }
                    delivery.fail(.windowExpired)
                }
            }
            try stream?.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
            let format = session.engine.inputNode.outputFormat(forBus: 0)
            guard format.commonFormat == .pcmFormatFloat32, (1...2).contains(format.channelCount),
                  (16_000...96_000).contains(format.sampleRate) else { throw DesktopAudioFailure.invalidAudio }
            session.engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, time in
                guard time.isHostTimeValid, time.isSampleTimeValid,
                      time.sampleRate == buffer.format.sampleRate else { delivery.fail(.invalidAudio); return }
                do {
                    let stamp = CMClockMakeHostTimeFromSystemUnits(time.hostTime)
                    delivery.offer(try AudioOutput.frame(buffer, channel: .microphone, time: stamp,
                                                        sourceSamplePosition: time.sampleTime))
                } catch { delivery.fail(.invalidAudio) }
            }
            session.tapInstalled = true
            session.observeInterruptions(workspaceCenter: workspaceCenter)
            session.engine.prepare()
            let starting = Task { if let stream { try await stream.startCapture() } }
            session.starting = starting
            try await withTaskCancellationHandler {
                try await starting.value
            } onCancel: {
                delivery.freeze()
                starting.cancel()
                Task { await self.terminate() }
            }
            guard active === session, phase == .starting, !Task.isCancelled else { throw DesktopAudioFailure.cancelled }
            if let window, window.remaining <= .zero { throw DesktopAudioFailure.windowExpired }
            // Avoid filling the microphone preroll while ScreenCaptureKit is
            // still starting. Recheck ownership after its suspension so a
            // cancelled/stopped start cannot restart the microphone.
            try session.engine.start()
            phase = .recording
        } catch {
            do { try await stop() }
            catch { throw DesktopAudioFailure.stopUnconfirmed }
            throw (error as? DesktopAudioFailure) ?? .unavailable
        }
    }

    /// Returns only after native start settles, both sources stop and all owned
    /// deliveries clear. Failure retains the same handles for a cleanup retry.
    /// The main controller still bounds this call and retains its lease/indicator
    /// on timeout; it must not treat cancellation as proof the OS stopped capture.
    public func stop(mode: DesktopAudioStopMode = .discard) async throws {
        guard let session = active else { phase = .stopped; return }
        phase = .stopping
        if mode == .drain { session.delivery.seal() }
        else { session.delivery.freeze() }
        session.deadline?.cancel()
        session.engine.stop()
        if session.tapInstalled {
            session.engine.inputNode.removeTap(onBus: 0); session.tapInstalled = false
        }
        session.removeObservers()
        let closing: CaptureStopAttempt
        if let pending = session.closing { closing = pending }
        else {
            let task = Task {
                if let starting = session.starting { _ = await starting.result }
                // A delegate-confirmed stop is authoritative even when a later
                // redundant stopCapture reports that the stream is already down.
                if !session.output.stopped { try await session.stream?.stopCapture() }
                await session.delivery.drain()
            }
            closing = CaptureStopAttempt(task: task)
            session.closing = closing
        }
        do {
            try await closing.task.value
            if active === session { active = nil; phase = .stopped }
        } catch {
            // A waiter from an older failed stop must not erase a newer retry.
            if active === session, session.closing?.id == closing.id {
                session.closing = nil; phase = .failed
            }
            throw DesktopAudioFailure.stopUnconfirmed
        }
    }

    private func terminate() async {
        do { try await stop() }
        catch { phase = .failed } // Host has already received fixed failure metadata.
    }

    private func armRenewableDeadline(_ session: CaptureSession) {
        session.deadline?.cancel()
        guard let window = session.window else { return }
        session.deadline = Task { [weak self] in
            do { try await Task.sleep(for: max(.zero, window.remaining)) }
            catch { return }
            await self?.expireRenewableWindow(session)
        }
    }

    private func expireRenewableWindow(_ session: CaptureSession) {
        guard active === session, phase == .starting || phase == .recording,
              let window = session.window, window.remaining <= .zero else { return }
        session.delivery.fail(.windowExpired)
    }
}

private struct CaptureStopAttempt: Sendable {
    let id = UUID()
    let task: Task<Void, Error>
}

@available(macOS 14.2, *)
private final class CaptureSession: @unchecked Sendable {
    let stream: SCStream?
    let output: AudioOutput
    let delivery: AudioDelivery
    let window: DesktopCaptureWindowOwner?
    let engine = AVAudioEngine()
    var tapInstalled = false
    var starting: Task<Void, Error>?
    var closing: CaptureStopAttempt?
    var deadline: Task<Void, Never>?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var workspaceCenter: NotificationCenter?
    private var engineObserver: NSObjectProtocol?

    init(stream: SCStream?, output: AudioOutput, delivery: AudioDelivery, window: DesktopCaptureWindowOwner?) {
        self.stream = stream; self.output = output; self.delivery = delivery
        self.window = window
    }

    func observeInterruptions(workspaceCenter: NotificationCenter) {
        self.workspaceCenter = workspaceCenter
        engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: engine, queue: nil) { [delivery] _ in delivery.fail(.engineConfigurationChanged) }
        workspaceObservers = [
            workspaceCenter.addObserver(forName: NSWorkspace.willSleepNotification,
                object: nil, queue: nil) { [delivery] _ in delivery.fail(.workspaceSleep) },
            workspaceCenter.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification,
                object: nil, queue: nil) { [delivery] _ in delivery.fail(.workspaceSessionInactive) },
        ]
    }

    func removeObservers() {
        if let engineObserver { NotificationCenter.default.removeObserver(engineObserver); self.engineObserver = nil }
        for observer in workspaceObservers { workspaceCenter?.removeObserver(observer) }
        workspaceObservers.removeAll(); workspaceCenter = nil
    }
}

@available(macOS 14.2, *)
final class AudioOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "scribe.desktop.audio.samples")
    let delivery: AudioDelivery
    private let lock = NSLock()
    private var didStop = false
    var stopped: Bool { lock.withLock { didStop } }
    init(delivery: AudioDelivery) { self.delivery = delivery; super.init() }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        lock.withLock { didStop = true }
        delivery.fail(.streamStopped)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { delivery.fail(.invalidAudio); return }
        do {
            guard CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer),
                  let description = CMSampleBufferGetFormatDescription(sampleBuffer),
                  let clock = stream.synchronizationClock else { throw DesktopAudioFailure.invalidAudio }
            let count = CMSampleBufferGetNumSamples(sampleBuffer)
            let format = AVAudioFormat(cmAudioFormatDescription: description)
            guard count > 0, count <= 8192, format.commonFormat == .pcmFormatFloat32,
                  (1...2).contains(format.channelCount), (16_000...96_000).contains(format.sampleRate),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else {
                throw DesktopAudioFailure.invalidAudio
            }
            buffer.frameLength = AVAudioFrameCount(count)
            guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(count),
                into: buffer.mutableAudioBufferList) == noErr else { throw DesktopAudioFailure.invalidAudio }
            let presentation = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            let position = CMTimeConvertScale(presentation, timescale: Int32(format.sampleRate), method: .roundHalfAwayFromZero)
            guard position.isNumeric else { throw DesktopAudioFailure.invalidAudio }
            let stamp = CMSyncConvertTime(presentation,
                                         from: clock, to: CMClockGetHostTimeClock())
            delivery.offer(try Self.frame(buffer, channel: .systemAudio, time: stamp,
                                         sourceSamplePosition: position.value))
        } catch { delivery.fail(.invalidAudio) }
    }

    static func frame(_ buffer: AVAudioPCMBuffer, channel: DesktopAudioChannel, time: CMTime,
                      sourceSamplePosition: Int64? = nil) throws -> DesktopAudioFrame {
        let frames = Int(buffer.frameLength), channels = Int(buffer.format.channelCount)
        let rate = buffer.format.sampleRate
        let stamp = CMTimeConvertScale(time, timescale: 1_000_000_000, method: .roundHalfAwayFromZero)
        guard frames > 0, frames <= 8192, (1...2).contains(channels), (16_000...96_000).contains(rate),
              rate.rounded() == rate, buffer.format.commonFormat == .pcmFormatFloat32,
              let data = buffer.floatChannelData, stamp.isNumeric, stamp.value > 0,
              buffer.stride == 1 || buffer.stride == channels else { throw DesktopAudioFailure.invalidAudio }
        var values = [Float](repeating: 0, count: frames * channels)
        defer { for i in values.indices { values[i] = 0 } }
        for index in 0..<frames {
            for c in 0..<channels {
                values[index * channels + c] = buffer.format.isInterleaved
                    ? data[0][index * channels + c] : data[c][index]
            }
        }
        return try DesktopAudioFrame(channel: channel, sampleRate: Int(rate), channels: channels,
            hostTimeNanoseconds: UInt64(stamp.value), sourceSamplePosition: sourceSamplePosition, samples: values)
    }
}
