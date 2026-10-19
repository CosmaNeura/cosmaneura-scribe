import Foundation

public enum DesktopAudioFailure: Error, Sendable, Equatable {
    case unavailable, permissionRequired, selectionChanged, cancelled, inputChanged
    case inputChangedContext(trigger: DesktopInputChangeTrigger, mismatch: UInt8)
    case invalidAudio, bufferOverflow, sinkRejected, stopUnconfirmed, windowExpired
    case clockDiscontinuity, meetingDisconnected

    /// Stable, content-free private-pipe diagnostics. Keep these numbers fixed
    /// across releases; never send an OS error message or device identity.
    var diagnosticReason: Int {
        switch self {
        case .unavailable: 1
        case .permissionRequired: 2
        case .selectionChanged: 3
        case .cancelled: 4
        case .inputChanged, .inputChangedContext: 5
        case .invalidAudio: 6
        case .bufferOverflow: 7
        case .sinkRejected: 8
        case .stopUnconfirmed: 9
        case .windowExpired: 10
        case .clockDiscontinuity: 11
        case .meetingDisconnected: 12
        }
    }
}

/// Fixed trigger numbers only; neither identities nor OS error text cross the
/// pipe. Associated context follows the same first-failure latch as its reason.
public enum DesktopInputChangeTrigger: Int, Sendable {
    case postStart = 1, configurationStarting = 2, configurationRecording = 3
    case workspaceSleep = 4, workspaceSessionResigned = 5
}

public enum DesktopAudioChannel: Sendable, Hashable { case microphone, systemAudio }

/// Native/main-process data only. No renderer, file, network or logging interface.
/// The sink may inspect/copy these samples synchronously; delivery clears them
/// before returning the queue slot. Each source retains its capture timestamp.
public final class DesktopAudioFrame: @unchecked Sendable {
    public let channel: DesktopAudioChannel
    public let sampleRate: Int
    public let channels: Int
    public let hostTimeNanoseconds: UInt64
    /// Position reported by the source clock, never a callback counter. Required
    /// for aligned mixing, which must distinguish clock drift from lost samples.
    public let sourceSamplePosition: Int64?
    private let lock = NSLock()
    private var samples: [Float]

    public init(channel: DesktopAudioChannel, sampleRate: Int, channels: Int,
                hostTimeNanoseconds: UInt64, sourceSamplePosition: Int64? = nil, samples: [Float]) throws {
        guard (16_000...96_000).contains(sampleRate), (1...2).contains(channels),
              hostTimeNanoseconds > 0, !samples.isEmpty, samples.count % channels == 0,
              samples.count / channels <= 8192, samples.allSatisfy(\.isFinite) else {
            throw DesktopAudioFailure.invalidAudio
        }
        self.channel = channel; self.sampleRate = sampleRate; self.channels = channels
        self.hostTimeNanoseconds = hostTimeNanoseconds; self.samples = samples
        self.sourceSamplePosition = sourceSamplePosition
    }

    deinit { clear() }

    public var frameCount: Int { lock.withLock { samples.count / channels } }
    public func withSamples<T>(_ body: (UnsafeBufferPointer<Float>) throws -> T) rethrows -> T {
        try lock.withLock { try samples.withUnsafeBufferPointer(body) }
    }
    public func clear() { lock.withLock { for i in samples.indices { samples[i] = 0 } } }
    var isClear: Bool { lock.withLock { samples.allSatisfy { $0 == 0 } } }
}

public protocol DesktopAudioSink: Sendable {
    /// Must consume/copy within this call. False terminates input; no silent drop.
    func receive(_ frame: DesktopAudioFrame) -> Bool
    /// Fixed metadata only. A failure requires main-process terminal cleanup.
    func failed(_ reason: DesktopAudioFailure)
}

/// Both capture callbacks enter one bounded native queue. Slow consumers fail
/// visibly instead of accumulating unbounded raw audio or silently dropping it.
final class AudioDelivery: @unchecked Sendable {
    private let lock = NSLock()
    private let queue: DispatchQueue
    private let sink: any DesktopAudioSink
    private let onFailure: @Sendable (DesktopAudioFailure) -> Void
    private let validate: @Sendable () -> Bool
    private var accepting = true
    private var discarding = false
    private var pending = 0
    private var lastTimes: [DesktopAudioChannel: UInt64] = [:]

    init(sink: any DesktopAudioSink, queue: DispatchQueue = DispatchQueue(label: "scribe.desktop.audio.delivery"),
         validate: @escaping @Sendable () -> Bool = { true },
         onFailure: @escaping @Sendable (DesktopAudioFailure) -> Void) {
        self.sink = sink; self.queue = queue; self.onFailure = onFailure; self.validate = validate
    }

    func offer(_ frame: DesktopAudioFrame) {
        let decision: Int = lock.withLock {
            guard accepting else { return 0 }
            guard validate() else { return 4 }
            guard pending < 4 else { return 2 }
            if let last = lastTimes[frame.channel], frame.hostTimeNanoseconds <= last { return 3 }
            lastTimes[frame.channel] = frame.hostTimeNanoseconds
            pending += 1
            // Enqueue under the admission lock, so freeze/drain cannot overtake
            // a reserved frame that has not yet reached the serial queue.
            queue.async { [self, frame] in
                defer { frame.clear(); lock.withLock { pending -= 1 } }
                guard !lock.withLock({ discarding }) else { return }
                guard validate() else { fail(.windowExpired); return }
                if !sink.receive(frame) { fail(.sinkRejected) }
            }
            return 1
        }
        guard decision == 1 else {
            frame.clear()
            if decision == 2 { fail(.bufferOverflow) }
            if decision == 3 { fail(.invalidAudio) }
            if decision == 4 { fail(.windowExpired) }
            return
        }
    }

    func fail(_ reason: DesktopAudioFailure) {
        let first = lock.withLock {
            guard !discarding else { return false }
            accepting = false; discarding = true
            return true
        }
        if first { sink.failed(reason); onFailure(reason) }
    }

    /// Normal stop: close admission but deliver frames accepted before stop.
    /// Sink failure during that drain still reports failure and discards the rest.
    func seal() { lock.withLock { accepting = false } }
    /// Interruption/abort: no queued sample may be treated as accepted continuity.
    func freeze() { lock.withLock { accepting = false; discarding = true } }
    func drain() async {
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
    }
}
