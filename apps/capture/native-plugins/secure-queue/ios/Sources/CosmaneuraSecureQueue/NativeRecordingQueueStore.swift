#if canImport(CosmaneuraNativeRecording)
  import CosmaneuraNativeRecording
  import Foundation

  /// Shares the existing queue's atomic writes, device key, backup exclusion and
  /// after-first-unlock file protection. No new JavaScript or plaintext API.
  // SecureQueueStore serializes all file/key operations under its shared lock.
  public final class NativeRecordingQueueStore: NativeRecordingRecordStore,
    NativeRecordingBindingRecordStore, @unchecked Sendable
  {
    private let store: SecureQueueStore

    public init() throws { store = try SecureQueueStore.shared.get() }

    public func read(key: String) throws -> NativeRecordingStoredRecord {
      let record = try store.get(key: key)
      return NativeRecordingStoredRecord(data: record.data, revision: record.revision)
    }

    public func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      _ = try store.compareAndSwap(key: key, expectedRevision: expectedRevision, data: data)
    }

    public func availableBytes() throws -> Int { try store.availableBytes() }

    public func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
      do { return try read(key: key) } catch SecureQueueError.notFound { return nil }
    }

    public func createBinding(key: String, data: Data) throws {
      _ = try store.create(key: key, data: data)
    }

    public func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
      try compareAndSwap(key: key, expectedRevision: expectedRevision, data: data)
    }
  }
#endif
