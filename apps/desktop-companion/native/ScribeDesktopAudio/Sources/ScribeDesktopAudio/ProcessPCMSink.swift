import Foundation

/// Copies at most four native PCM packets while awaiting main-process acceptance
/// and any completed WAV persistence. A partial chunk remains bounded in memory.
/// Only one packet is written before its exact frame acknowledgement.
final class ProcessPCMSink: DesktopPCMSink, @unchecked Sendable {
    private final class Packet {
        let firstFrame: Int
        private var bytes: Data
        init(firstFrame: Int, bytes: Data) { self.firstFrame = firstFrame; self.bytes = bytes }
        deinit { clear() }
        func send(to output: ProcessOutput) { output.pcm(firstFrame: firstFrame, bytes: bytes) }
        func clear() { bytes.resetBytes(in: 0..<bytes.count) }
    }
    private let lock = NSLock()
    private let output: ProcessOutput
    private let onFailure: @Sendable (DesktopAudioFailure) -> Void
    private var start: DesktopPCMStart?
    private var nativeReady = false
    private var readySent = false
    private var activated = false
    private var discarding = false
    private var packets: [Packet] = []
    private var inFlight: Packet?
    private var expectedFrame = 0
    private var waiters: [CheckedContinuation<Void, Error>] = []

    init(output: ProcessOutput, onFailure: @escaping @Sendable (DesktopAudioFailure) -> Void) {
        self.output = output; self.onFailure = onFailure
    }
    func started(_ value: DesktopPCMStart) -> Bool {
        lock.withLock {
            guard !discarding, start == nil else { return false }
            start = value; announceReady(); return true
        }
    }
    func nativeStarted() { lock.withLock { nativeReady = true; announceReady() } }
    private func announceReady() {
        guard !discarding, nativeReady, let start, !readySent else { return }
        readySent = true
        output.metadata(["type": "ready", "start": start.wireValue])
    }
    func activate() -> Bool {
        lock.withLock {
            guard !discarding, readySent, !activated else { return false }
            activated = true; sendNext(); return true
        }
    }
    func receive(_ packet: DesktopPCMPacket) -> Bool {
        lock.withLock {
            guard !discarding, start != nil, packet.firstFrame == expectedFrame,
                  packets.count + (inFlight == nil ? 0 : 1) < 4, (1...4096).contains(packet.frameCount),
                  output.isValid else { return false }
            var bytes = Data(count: packet.frameCount * 2)
            packet.withSamples { samples in
                bytes.withUnsafeMutableBytes { (destination: UnsafeMutableRawBufferPointer) in
                    for i in samples.indices {
                        let value = UInt16(bitPattern: samples[i])
                        destination[i * 2] = UInt8(value & 255); destination[i * 2 + 1] = UInt8(value >> 8)
                    }
                }
            }
            expectedFrame += packet.frameCount
            packets.append(Packet(firstFrame: packet.firstFrame, bytes: bytes))
            bytes.resetBytes(in: 0..<bytes.count)
            sendNext(); return true
        }
    }
    func acknowledge(_ firstFrame: Int) -> Bool {
        lock.withLock {
            if discarding { return true } // An in-flight acknowledgement may outlive discard.
            guard let sent = inFlight, sent.firstFrame == firstFrame else { return false }
            sent.clear(); inFlight = nil
            sendNext(); resolveDrain(); return true
        }
    }
    private func sendNext() {
        guard !discarding, activated, inFlight == nil, !packets.isEmpty else { return }
        let packet = packets.removeFirst(); inFlight = packet
        packet.send(to: output)
    }
    func failed(_ reason: DesktopAudioFailure) {
        let first = lock.withLock { clearPending() }
        if first { onFailure(reason) }
    }
    func discard() { lock.withLock { _ = clearPending() } }
    private func clearPending() -> Bool {
        guard !discarding else { return false }
        discarding = true
        packets.forEach { $0.clear() }
        packets.removeAll()
        inFlight?.clear(); inFlight = nil
        let current = waiters; waiters.removeAll()
        current.forEach { $0.resume(throwing: DesktopAudioFailure.cancelled) }
        return true
    }
    func drain() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.withLock {
                if discarding { continuation.resume(throwing: DesktopAudioFailure.cancelled) }
                else if inFlight == nil && packets.isEmpty { continuation.resume() }
                else if waiters.count < 4 { waiters.append(continuation) }
                else { continuation.resume(throwing: DesktopAudioFailure.bufferOverflow) }
            }
        }
    }
    private func resolveDrain() {
        guard inFlight == nil, packets.isEmpty else { return }
        let current = waiters; waiters.removeAll(); current.forEach { $0.resume() }
    }
}
