import Foundation

/// Generic Capacitor storage cannot inspect or mutate native recovery custody.
/// Native recording uses SecureQueueStore directly; encrypted upload records
/// retain the existing renderer interface and atomic revision semantics.
final class RendererSecureQueueStore {
  private let store: SecureQueueStore
  init(store: SecureQueueStore) { self.store = store }

  func put(key: String, data: Data) throws -> UInt64 {
    try allow(key)
    return try store.put(key: key, data: data)
  }
  func create(key: String, data: Data) throws -> UInt64 {
    try allow(key)
    return try store.create(key: key, data: data)
  }
  func get(key: String) throws -> SecureQueueRecord {
    try allow(key)
    return try store.get(key: key)
  }
  func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws -> UInt64 {
    try allow(key)
    return try store.compareAndSwap(key: key, expectedRevision: expectedRevision, data: data)
  }
  func delete(key: String) throws -> Bool {
    try allow(key)
    return try store.delete(key: key)
  }
  func list() throws -> [String] { try store.list().filter(SecureQueueRecordCodec.isRendererKey) }
  func clear() throws -> Int { try store.clear(forRenderer: true) }
  func availableBytes() throws -> Int { try store.availableBytes() }

  private func allow(_ key: String) throws {
    guard SecureQueueRecordCodec.isRendererKey(key) else { throw SecureQueueError.invalidArgument }
  }
}
