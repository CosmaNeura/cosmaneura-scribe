import Foundation

/// ScreenCaptureKit discovery does not guarantee cooperative cancellation.
/// Bound only that system lookup; the subsequent deliberate human choice has
/// no artificial deadline. A late lookup cannot reopen a cancelled picker.
@MainActor
final class ProviderWindowDiscovery<Value: Sendable> {
    private var started = false
    private var continuation: CheckedContinuation<Value, any Error>?
    private var loading: Task<Void, Never>?
    private var deadline: Task<Void, Never>?

    func load(timeout: Duration = .seconds(10),
              operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        guard !started else { throw ProviderPresentationFailure.busy }
        started = true
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { pending in
                continuation = pending
                // An unstructured task is intentional: a task group would wait
                // for an uncooperative system lookup before returning Cancel.
                loading = Task { @MainActor in
                    do {
                        try Task.checkCancellation()
                        let value = try await operation()
                        try Task.checkCancellation()
                        finish(.success(value))
                    } catch { finish(.failure(error)) }
                }
                deadline = Task { @MainActor in
                    do { try await Task.sleep(for: timeout) } catch { return }
                    finish(.failure(ProviderPresentationFailure.unavailable))
                }
            }
        } onCancel: {
            Task { @MainActor in self.finish(.failure(ProviderPresentationFailure.cancelled)) }
        }
    }

    private func finish(_ result: Result<Value, any Error>) {
        guard let pending = continuation else { return }
        continuation = nil
        loading?.cancel(); loading = nil
        deadline?.cancel(); deadline = nil
        pending.resume(with: result)
    }
}
