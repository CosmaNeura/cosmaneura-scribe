import CosmaneuraIOSPCMCore
import Foundation
import Testing

struct StartupDiagnosticsTests {
  @Test func recordsOnlyBoundedPrivateLifecycleMetadata() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("startup.json")
    let journal = PCMStartupDiagnostics()
    journal.configure(destination: file)
    await withTaskGroup(of: Void.self) { group in
      for _ in 0..<200 { group.addTask { journal.record(.startRequested) } }
    }
    await journal.flush()
    let data = try Data(contentsOf: file)
    let entries = try #require(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    #expect(entries.count == PCMStartupDiagnostics.maximumEvents)
    #expect(data.count <= 32_768)
    for entry in entries {
      #expect(Set(entry.keys) == ["utc", "event"])
      #expect(entry["event"] as? String == "startRequested")
      #expect(ISO8601DateFormatter().date(from: try #require(entry["utc"] as? String)) != nil)
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
  }

  @Test func disabledJournalDoesNotRetainEarlierEventsOrAcceptRedirection() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = directory.appendingPathComponent("first.json")
    let redirected = directory.appendingPathComponent("redirected.json")
    let journal = PCMStartupDiagnostics()
    journal.record(.startRequested)
    journal.configure(destination: first)
    journal.configure(destination: redirected)
    journal.record(.readyRejected)
    await journal.flush()
    let entries = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: first)) as? [[String: Any]])
    #expect(entries.count == 1)
    #expect(entries[0]["event"] as? String == "readyRejected")
    #expect(!FileManager.default.fileExists(atPath: redirected.path))
  }

  @Test func storageFailureDoesNotPropagateIntoCaptureCleanup() async {
    let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      .appendingPathComponent("missing-parent").appendingPathComponent("startup.json")
    let journal = PCMStartupDiagnostics()
    journal.configure(destination: missing)
    journal.record(.stopRequested)
    journal.record(.stopAccepted)
    await journal.flush()
    #expect(!FileManager.default.fileExists(atPath: missing.path))
  }
}
