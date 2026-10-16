@preconcurrency import AVFoundation
import Foundation

/// Catalogue-only preparation. No engine, tap or audio samples are acquired.
/// Live input levels belong to the consent-authorized recording process.
public enum MicrophoneCheckProcess {
    @MainActor public static func run(input: FileHandle = .standardInput, output: FileHandle = .standardOutput) async -> Int32 {
        await run(input: input, output: output, catalogue: MicrophoneCatalogue())
    }

    @MainActor static func run(input: FileHandle, output: FileHandle, catalogue: MicrophoneCatalogue) async -> Int32 {
        let check = MicrophoneCheckOwner(output: ProcessOutput(output), catalogue: catalogue)
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
    init(output: ProcessOutput, catalogue: MicrophoneCatalogue) { self.output = output; self.catalogue = catalogue }

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
        default: await close(); return false
        }
    }
    func close() async {
        guard !closed else { return }
        closed = true
        await output.drain()
        waiter?.resume(returning: 0); waiter = nil
    }
    func wait() async -> Int32 {
        if closed { return 0 }
        return await withCheckedContinuation { waiter = $0 }
    }
}
