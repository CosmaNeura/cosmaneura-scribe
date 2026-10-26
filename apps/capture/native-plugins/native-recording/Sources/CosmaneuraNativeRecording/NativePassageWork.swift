import Foundation

/// Owned native CPU/storage work. The caller awaits completion even after
/// cancellation; the operation checks cancellation between bounded records.
public func nativePassageWork<T: Sendable>(
  _ operation: @escaping @Sendable () throws -> T
) async throws -> T {
  let worker = Task.detached(priority: .userInitiated) {
    try Task.checkCancellation()
    return try operation()
  }
  return try await withTaskCancellationHandler {
    let value = try await worker.value
    try Task.checkCancellation()
    return value
  } onCancel: { worker.cancel() }
}
