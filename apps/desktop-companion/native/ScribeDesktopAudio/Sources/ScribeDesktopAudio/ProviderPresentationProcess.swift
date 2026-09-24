import CoreFoundation
import Foundation

public enum ProviderPresentationEvent: Sendable {
    case stopRequested(UUID), visibilityLost(UUID)
}

@MainActor
public protocol ProviderPresentationSurface: AnyObject {
    var onEvent: (@MainActor (ProviderPresentationEvent) -> Void)? { get set }
    func choose() async throws -> MeetingAudioSelection
    func publish(_ state: ProviderRecordingPresentation) throws
    func verifyVisibility()
}

/// Only the separate, explicitly selected presentation executable constructs this.
/// Neither this surface nor its pipe can open an audio source or confer authority.
@MainActor
public final class MacProviderPresentationSurface: ProviderPresentationSurface {
    public var onEvent: (@MainActor (ProviderPresentationEvent) -> Void)?
    private let picker = MacProviderWindowPicker(enabled: true)
    private lazy var indicator = MacProviderRecordingIndicator(enabled: true,
        requestStop: { [weak self] in self?.onEvent?(.stopRequested($0)) },
        visibilityLost: { [weak self] in self?.onEvent?(.visibilityLost($0)) })
    public init() {}
    public func choose() async throws -> MeetingAudioSelection { try await picker.choose() }
    public func publish(_ state: ProviderRecordingPresentation) throws { try indicator.publish(state) }
    public func verifyVisibility() { indicator.verifyVisibility() }
}

/// Private inherited metadata pipes. The executable owns the Cocoa run loop.
/// Parent loss during an active presentation retains an unconfirmed-stop warning;
/// this UI process cannot attest that the separate audio process has stopped.
public enum ProviderPresentationProcess {
    @MainActor
    public static func run(surface: any ProviderPresentationSurface,
                           input: FileHandle = .standardInput, output: FileHandle = .standardOutput) async -> Int32 {
        let host = PresentationHost(surface: surface, output: ProcessOutput(output))
        let reader = PresentationInput(input)
        let reading = Task.detached {
            do {
                while let command = try reader.next() { await host.accept(command) }
                await host.disconnect()
            } catch { await host.disconnect() }
        }
        let heartbeat = Task { @MainActor in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                host.checkParent()
            }
        }
        let result = await host.wait()
        reading.cancel(); heartbeat.cancel()
        return result
    }
}

private enum PresentationCommand: Sendable {
    case choose(Int), cancel(Int), publish(Int, ProviderRecordingPresentation), heartbeat(Int), close(Int)
    static func parse(_ data: Data) throws -> Self {
        guard data.first == 1, data.count <= 2048,
              let value = try JSONSerialization.jsonObject(with: data.dropFirst()) as? [String: Any],
              let kind = value["type"] as? String,
              let number = value["request"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 1, number.doubleValue <= Double(Int32.max) else { throw invalid() }
        let request = number.intValue
        func keys(_ expected: Set<String>) throws { guard Set(value.keys) == expected else { throw invalid() } }
        switch kind {
        case "choose": try keys(["type", "request"]); return .choose(request)
        case "cancel": try keys(["type", "request"]); return .cancel(request)
        case "heartbeat": try keys(["type", "request"]); return .heartbeat(request)
        case "close": try keys(["type", "request"]); return .close(request)
        case "publish":
            try keys(["type", "request", "phase", "session"])
            guard let phase = value["phase"] as? String else { throw invalid() }
            if phase == "inactive", value["session"] is NSNull { return .publish(request, .inactive) }
            guard let raw = value["session"] as? String, let session = UUID(uuidString: raw),
                  session.uuidString.lowercased() == raw else { throw invalid() }
            if phase == "recording" { return .publish(request, .recording(session)) }
            if phase == "failed" { return .publish(request, .failed(session)) }
            throw invalid()
        default: throw invalid()
        }
    }
}

private final class PresentationInput: @unchecked Sendable {
    private let input: FileHandle
    init(_ input: FileHandle) { self.input = input }
    func next() throws -> PresentationCommand? {
        guard let header = try read(4) else { return nil }
        let count = header.reduce(0) { $0 * 256 + Int($1) }
        guard (2...2048).contains(count), let body = try read(count) else { throw invalid() }
        return try PresentationCommand.parse(body)
    }
    private func read(_ count: Int) throws -> Data? {
        var data = Data()
        while data.count < count {
            guard let part = try input.read(upToCount: count - data.count), !part.isEmpty else {
                if data.isEmpty { return nil }
                throw invalid()
            }
            data.append(part)
        }
        return data
    }
}

@MainActor
private final class PresentationHost {
    private let surface: any ProviderPresentationSurface
    private let output: ProcessOutput
    private var state: ProviderRecordingPresentation = .inactive
    private var choice: (request: Int, task: Task<Void, Never>)?
    private var lastRequest = 0
    private var lastInput = ContinuousClock.now
    private var disconnected = false
    private var finishing = false
    private var result: Int32?
    private var waiter: CheckedContinuation<Int32, Never>?

    init(surface: any ProviderPresentationSurface, output: ProcessOutput) {
        self.surface = surface; self.output = output
        surface.onEvent = { [weak self] event in self?.event(event) }
        output.metadata(["type": "ready", "version": 1])
    }
    func wait() async -> Int32 {
        await withCheckedContinuation { continuation in
            if let result { continuation.resume(returning: result) }
            else { waiter = continuation }
        }
    }
    func accept(_ command: PresentationCommand) {
        guard !disconnected, !finishing else { return }
        lastInput = .now
        if case .cancel(let request) = command {
            // A selection already in the pipe can race a cancellation. No new
            // choice or state is created by a late cancellation.
            if choice?.request == request { choice?.task.cancel() }
            else if request > lastRequest { disconnect() }
            return
        }
        let request: Int
        switch command {
        case .choose(let id), .publish(let id, _), .heartbeat(let id), .close(let id): request = id
        case .cancel: return
        }
        guard request > lastRequest else { disconnect(); return }
        lastRequest = request
        switch command {
        case .choose:
            guard choice == nil, state == .inactive else { refuse(request); return }
            let task = Task { @MainActor in
                do {
                    let selected = try await surface.choose()
                    try Task.checkCancellation()
                    guard !disconnected, choice?.request == request else { return }
                    output.metadata(["type": "selected", "request": request,
                        "application": selected.application.rawValue,
                        "processID": selected.processID, "windowID": selected.windowID])
                } catch {
                    if !disconnected { output.metadata(["type": "unavailable", "request": request]) }
                }
                if choice?.request == request { choice = nil }
            }
            choice = (request, task)
        case .publish(_, let next):
            guard choice == nil else { refuse(request); return }
            if let prior = state.session, let incoming = next.session, prior != incoming { refuse(request); return }
            if case .failed = state, case .recording = next { refuse(request); return }
            let prior = state
            // A synchronous visibility callback must see the incoming session.
            state = next
            do {
                try surface.publish(next)
                if next != .inactive, state != next { refuse(request); return }
                output.metadata(["type": "published", "request": request])
            } catch {
                if let session = next.session ?? prior.session {
                    state = .failed(session); try? surface.publish(state)
                    output.metadata(["type": "visibilityLost", "session": session.uuidString.lowercased()])
                } else { state = prior }
                refuse(request)
            }
        case .heartbeat:
            surface.verifyVisibility()
            output.metadata(["type": "heartbeat", "request": request])
        case .close:
            guard choice == nil, state == .inactive else { refuse(request); return }
            output.metadata(["type": "closed", "request": request]); finish(0)
        case .cancel: break
        }
    }
    private func event(_ event: ProviderPresentationEvent) {
        switch event {
        case .stopRequested(let session):
            guard state.session == session else { return }
            output.metadata(["type": "stopRequested", "session": session.uuidString.lowercased()])
        case .visibilityLost(let session):
            guard state.session == session else { return }
            state = .failed(session)
            output.metadata(["type": "visibilityLost", "session": session.uuidString.lowercased()])
        }
    }
    private func refuse(_ request: Int) { output.metadata(["type": "unavailable", "request": request]) }
    func checkParent() {
        guard !finishing else { return }
        surface.verifyVisibility()
        if !output.isValid || ContinuousClock.now - lastInput > .seconds(6) { disconnect() }
    }
    func disconnect() {
        guard !disconnected, !finishing else { return }
        disconnected = true; choice?.task.cancel(); output.invalidate()
        if let session = state.session {
            state = .failed(session); try? surface.publish(state)
            // Keep the warning; loss of the host is not a source-stop receipt.
        } else { finish(1) }
    }
    private func finish(_ code: Int32) {
        guard !finishing else { return }
        finishing = true
        Task { @MainActor in
            await output.drain()
            result = code; waiter?.resume(returning: code); waiter = nil
        }
    }
}

private func invalid() -> ProviderPresentationFailure { .unavailable }
