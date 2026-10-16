@preconcurrency import AVFoundation
import Foundation

/// Explicit audio-check mode. Its only output is scalar amplitude/device
/// metadata. It cannot construct PCM frames, acquire a clinical capture fence,
/// write audio, or enter the encryption/transcription pipeline.
public enum MicrophoneCheckProcess {
    @MainActor public static func run(input: FileHandle = .standardInput, output: FileHandle = .standardOutput) async -> Int32 {
        let check = MicrophoneCheckOwner(output: ProcessOutput(output))
        let reader = ProcessInput(input)
        Task.detached {
            do {
                while let command = try reader.next() {
                    if !(await check.accept(command)) { break }
                }
            } catch { }
            await check.close()
        }
        Task { @MainActor in
            while !check.closed {
                try? await Task.sleep(for: .seconds(5))
                if ContinuousClock.now - check.lastInput > .seconds(15) { await check.close() }
            }
        }
        await check.prepare()
        return await check.wait()
    }
}

@MainActor private final class MicrophoneCheckOwner {
    let output: ProcessOutput
    let meter: MicrophoneCheckMeter
    var engine: AVAudioEngine?
    var closed = false
    var lastInput = ContinuousClock.now
    private var waiter: CheckedContinuation<Int32, Never>?
    init(output: ProcessOutput) { self.output = output; self.meter = MicrophoneCheckMeter(output: output) }

    func prepare() async {
        guard !closed else { return }
        do {
            let devices = try MacMicrophoneInputs.list()
            let available = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
            let uid = try MacMicrophoneInputs.defaultUID()
            guard devices.count <= 32 else { throw DesktopAudioFailure.unavailable }
            for device in devices { output.metadata(["type": "input", "device": device.wireValue]) }
            output.metadata(["type": "inputs", "available": available,
                "count": devices.count, "selectedUID": uid])
            // Wait for the main-owned persisted selection before any tap starts.
        } catch { output.metadata(["type": "unavailable"]) }
    }

    func accept(_ command: ProcessCommand) async -> Bool {
        guard !closed else { return false }
        lastInput = .now
        switch command {
        case .heartbeat:
            if engine != nil && AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { await close(); return false }
            return true
        case .selectMicrophone(let request, let uid):
            do {
                guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw DesktopAudioFailure.permissionRequired }
                stopEngine()
                let next = AVAudioEngine()
                engine = next
                try MacMicrophoneInputs.select(uid, engine: next)
                let format = next.inputNode.outputFormat(forBus: 0)
                guard format.commonFormat == .pcmFormatFloat32, (1...32).contains(format.channelCount),
                      format.sampleRate > 0 else { throw DesktopAudioFailure.invalidAudio }
                let meter = meter
                meter.enable()
                next.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in meter.offer(buffer) }
                next.prepare(); try next.start()
                output.metadata(["type": "selected", "request": request, "uid": uid])
            } catch {
                stopEngine()
                output.metadata(["type": "selectionFailed", "request": request])
            }
            return true
        case .stop(let request, _):
            stopEngine()
            output.metadata(["type": "checkStopped", "request": request])
            await close(); return false
        default: await close(); return false
        }
    }
    private func stopEngine() {
        meter.disable()
        if let engine { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        engine = nil
    }
    func close() async {
        guard !closed else { return }
        closed = true; stopEngine()
        await output.drain()
        waiter?.resume(returning: 0); waiter = nil
    }
    func wait() async -> Int32 {
        if closed { return 0 }
        return await withCheckedContinuation { waiter = $0 }
    }
}

private final class MicrophoneCheckMeter: @unchecked Sendable {
    private let output: ProcessOutput
    private let lock = NSLock()
    private var active = false
    private var last = ContinuousClock.now
    private var sequence = 0
    init(output: ProcessOutput) { self.output = output }
    func enable() { lock.withLock { active = true } }
    func disable() { lock.withLock { active = false } }
    func offer(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            guard active, ContinuousClock.now - last >= .milliseconds(200),
                  let data = buffer.floatChannelData, buffer.frameLength <= 8192 else { return }
            var peak: Float = 0
            let channels = Int(buffer.format.channelCount), frames = Int(buffer.frameLength)
            for frame in 0..<frames {
                for channel in 0..<channels {
                    let value = buffer.format.isInterleaved ? data[0][frame * channels + channel] : data[channel][frame]
                    if value.isFinite { peak = max(peak, min(1, abs(value))) }
                }
            }
            last = .now; sequence += 1
            output.metadata(["type": "checkLevel", "sequence": sequence, "level": Double(peak)])
        }
    }
}
