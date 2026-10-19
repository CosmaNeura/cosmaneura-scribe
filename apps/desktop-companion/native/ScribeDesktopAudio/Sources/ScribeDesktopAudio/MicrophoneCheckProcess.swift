@preconcurrency import AVFoundation
import Foundation

/// Catalogue-only preparation. No engine, tap or audio samples are acquired.
/// Live input levels belong to the consent-authorized recording process.
public enum MicrophoneCheckProcess {
    @MainActor public static func run(input: FileHandle = .standardInput, output: FileHandle = .standardOutput, lifetime: NativeProcessLifetime? = nil) async -> Int32 {
        await run(input: input, output: output, catalogue: MicrophoneCatalogue(), lifetime: lifetime)
    }

    @MainActor static func run(input: FileHandle, output: FileHandle, catalogue: MicrophoneCatalogue, lifetime: NativeProcessLifetime? = nil) async -> Int32 {
        let check = MicrophoneCheckOwner(output: ProcessOutput(output), catalogue: catalogue, strictTransport: lifetime != nil)
        let reader = ProcessInput(input, lifetime: lifetime)
        lifetime?.onCancel { Task { @MainActor in await check.close(code: 70) } }
        let reading = Task.detached {
            do {
                while let command = try reader.next() {
                    if !(await check.accept(command)) { break }
                }
            } catch { await check.close(code: lifetime == nil ? 0 : 70) }
            await check.close()
        }
        let heartbeat = Task { @MainActor in
            while !check.closed {
                try? await Task.sleep(for: .seconds(5))
                if ContinuousClock.now - check.lastInput > .seconds(15) { await check.close(code: lifetime == nil ? 0 : 70) }
            }
        }
        if lifetime?.isCancelled == true { await check.close(code: 70) }
        else { await check.prepare() }
        let result = await check.wait()
        if let lifetime { lifetime.finishReading(); await reading.value; heartbeat.cancel() }
        return result
    }
}

struct MicrophoneCatalogue: Sendable {
    var devices: @Sendable () throws -> [MacMicrophoneInput] = { try MacMicrophoneInputs.list() }
    var defaultUID: @Sendable () throws -> String = { try MacMicrophoneInputs.defaultUID() }
    var authorized: @Sendable () -> Bool = { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
}

@MainActor private final class MicrophoneCheckOwner {
    let catalogue: MicrophoneCatalogue
    let output: ProcessOutput
    var closed = false
    var lastInput = ContinuousClock.now
    private var waiter: CheckedContinuation<Int32, Never>?
    private let strictTransport: Bool
    private var result: Int32 = 0
    private var finished = false
    init(output: ProcessOutput, catalogue: MicrophoneCatalogue, strictTransport: Bool = false) {
        self.output = output; self.catalogue = catalogue; self.strictTransport = strictTransport
    }

    func prepare() async {
        guard !closed else { return }
        do {
            let devices = try catalogue.devices()
            let available = catalogue.authorized()
            let uid = try catalogue.defaultUID()
            guard devices.count <= 32 else { throw DesktopAudioFailure.unavailable }
            for device in devices { output.metadata(["type": "input", "device": device.wireValue]) }
            output.metadata(["type": "inputs", "available": available,
                "count": devices.count, "selectedUID": uid])
        } catch { output.metadata(["type": "unavailable"]) }
    }

    func accept(_ command: ProcessCommand) async -> Bool {
        guard !closed else { return false }
        lastInput = .now
        switch command {
        case .heartbeat:
            return true
        case .selectMicrophone(let request, let uid):
            do {
                // Main chooses only a UID freshly present in the OS catalogue.
                // Actual hardware selection happens in the authorized source.
                guard try catalogue.devices().contains(where: { $0.uid == uid }) else {
                    throw DesktopAudioFailure.unavailable
                }
                output.metadata(["type": "selected", "request": request, "uid": uid])
            } catch {
                output.metadata(["type": "selectionFailed", "request": request])
            }
            return true
        case .stop(let request, _):
            output.metadata(["type": "checkStopped", "request": request])
            await close(); return false
        default: await close(code: strictTransport ? 70 : 0); return false
        }
    }
    func close(code: Int32 = 0) async {
        guard !closed else { return }
        closed = true
        await output.drain()
        result = strictTransport && !output.isValid ? 70 : code
        finished = true
        waiter?.resume(returning: result); waiter = nil
    }
    func wait() async -> Int32 {
        if closed && (!strictTransport || finished) { return result }
        return await withCheckedContinuation { waiter = $0 }
    }
}
