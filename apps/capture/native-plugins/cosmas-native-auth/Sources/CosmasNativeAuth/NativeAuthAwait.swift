import Foundation

/// A cancelled SDK task may ignore cancellation. Release its caller promptly,
/// fence access first, and discard any late result without waiting for that task.
/// The owner separately retains in-flight mutation guards until the SDK returns.
@MainActor final class NativeAuthAwait<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, any Error>?
    private var worker: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var abandoned = false
    private var completed = false
    private var onAbandon: (@MainActor () -> Void)?

    func run(timeout: Duration, onAbandon: @escaping @MainActor () -> Void,
             operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        self.onAbandon = onAbandon
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                worker = Task { @MainActor in
                    do { self.finish(.success(try await operation())) }
                    catch { self.finish(.failure(error)) }
                }
                watchdog = Task { @MainActor in
                    do { try await Task.sleep(for: timeout); self.abandon() }
                    catch { /* A completed operation cancels its watchdog. */ }
                }
                if abandoned || Task.isCancelled { abandon() }
            }
        } onCancel: {
            Task { @MainActor in self.abandon() }
        }
    }

    private func abandon() {
        abandoned = true
        guard !completed, continuation != nil else { return }
        onAbandon?()
        worker?.cancel()
        finish(.failure(CancellationError()))
    }

    private func finish(_ result: Result<Value, any Error>) {
        guard !completed, let continuation else { return }
        completed = true
        self.continuation = nil
        watchdog?.cancel()
        watchdog = nil
        worker = nil
        onAbandon = nil
        continuation.resume(with: result)
    }
}
