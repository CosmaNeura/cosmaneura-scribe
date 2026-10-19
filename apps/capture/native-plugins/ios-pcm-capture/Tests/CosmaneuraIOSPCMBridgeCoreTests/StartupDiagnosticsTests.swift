import CosmaneuraIOSPCMCore
import Foundation
import Testing

struct StartupDiagnosticsTests {
  @Test func readyTimingAllowsOnlyBoundedNumericFieldsAndDoesNotChangeLifecycleRows() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("startup.json"), journal = PCMStartupDiagnostics()
    journal.configure(destination: file)
    journal.record(.recordToNativeReady) // A timing event without duration is invalid.
    for duration in [-1, Double.infinity, Double.nan, 3_600_001] {
      journal.recordReadyTiming(milliseconds: duration, buildNumber: 78)
    }
    journal.record(.startRequested)
    journal.recordReadyTiming(milliseconds: 5500.1234, buildNumber: 78)
    journal.recordReadyTiming(milliseconds: 0, buildNumber: -1)
    await journal.flush()
    let rows = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
    #expect(rows.count == 3)
    #expect(Set(rows[0].keys) == ["utc", "event"])
    #expect(Set(rows[1].keys) == ["utc", "event", "duration_ms", "build_number"])
    #expect(rows[1]["event"] as? String == "recordToNativeReady")
    #expect(rows[1]["duration_ms"] as? Double == 5500.123)
    #expect(rows[1]["build_number"] as? Int == 78)
    #expect(Set(rows[2].keys) == ["utc", "event", "duration_ms"])
    #expect(rows[2]["duration_ms"] as? Double == 0)
  }
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
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    for entry in entries {
      #expect(Set(entry.keys) == ["utc", "event"])
      #expect(entry["event"] as? String == "startRequested")
      let utc = try #require(entry["utc"] as? String)
      #expect(utc.contains("."))
      #expect(formatter.date(from: utc) != nil)
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
  }

  @Test func recordsFirstBuffersSeparatelyFromFirstNonzeroSignalWithoutRepeatedSpeechEvents() async throws {
    // Invented PCM only, under synthetic test consent; no OS microphone opens.
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("startup.json")
    let journal = PCMStartupDiagnostics()
    journal.configure(destination: file)
    let monitor = PCMSignalMonitor(diagnostics: journal)
    monitor.recordInput([[0, 0]], sampleRateHz: 16_000)
    monitor.recordConverted([0, 0])
    await journal.flush()
    var entries = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
    #expect(entries.compactMap { $0["event"] as? String } == ["firstInputBuffer", "firstConvertedBuffer"])
    for _ in 0..<100 {
      monitor.recordInput([[0.125, -0.125]], sampleRateHz: 16_000)
      monitor.recordConverted([4096, -4096])
      monitor.recordInput([[0, 0]], sampleRateHz: 16_000)
      monitor.recordConverted([0, 0])
    }
    await journal.flush()
    entries = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
    #expect(entries.compactMap { $0["event"] as? String } == [
      "firstInputBuffer", "firstConvertedBuffer", "firstInputSignal", "firstConvertedSignal",
    ])
    #expect(entries.allSatisfy { Set($0.keys) == ["utc", "event"] })
    monitor.reset()
    monitor.recordInput([[0.125]], sampleRateHz: 16_000)
    monitor.recordConverted([4096])
    await journal.flush()
    entries = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
    #expect(entries.count == 8)
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
