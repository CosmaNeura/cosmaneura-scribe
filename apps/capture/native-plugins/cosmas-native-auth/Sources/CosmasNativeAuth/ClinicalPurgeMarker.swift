import Foundation

/// Durable native purge marker (H2). Wipe only after `confirmed`.
public enum ClinicalPurgeMarker {
    public enum State: String { case prepared, sent, confirmed }
    private static var fileURL: URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = root.appendingPathComponent("CosmaneuraClinicalPurge", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("clinical-purge-pending-v1.json")
    }
    public static var exists: Bool { FileManager.default.fileExists(atPath: fileURL.path) }
    public static func readState() -> State? {
        guard let data = try? Data(contentsOf: fileURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = object["state"] as? String else { return nil }
        return State(rawValue: raw)
    }
    public static func write(_ state: State) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["state": state.rawValue, "v": 1]) else { return }
        try? data.write(to: fileURL, options: [.atomic])
    }
    public static func abandonPrepared() {
        guard readState() == .prepared else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
    public static func clear() { try? FileManager.default.removeItem(at: fileURL) }
    /// Launch/sign-in retry: wipe only when already confirmed — never promote prepared/sent.
    @MainActor
    public static func retryPurge(clearAll: () throws -> Int) throws -> Bool {
        guard readState() == .confirmed else { return false }
        if try clearAll() != 0 { throw NSError(domain: "clinical_purge", code: 1) }
        clear(); return true
    }
}
