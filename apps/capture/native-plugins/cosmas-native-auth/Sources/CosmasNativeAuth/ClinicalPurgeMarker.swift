import Foundation

/// Durable native purge marker (H2/H3). Wipe only after `confirmed`.
/// v2 carries optional accountId for per-account launch retry; v1 no-id may clearAll.
public enum ClinicalPurgeMarker {
    public enum State: String { case prepared, sent, confirmed }

    private static var fileURL: URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = root.appendingPathComponent("CosmaneuraClinicalPurge", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var mutable = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
        return dir.appendingPathComponent("clinical-purge-pending-v1.json")
    }

    public static var exists: Bool { FileManager.default.fileExists(atPath: fileURL.path) }

    public static func readState() -> State? {
        guard let data = try? Data(contentsOf: fileURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = object["state"] as? String else { return nil }
        return State(rawValue: raw)
    }

    public static func readAccountId() -> String? {
        guard let data = try? Data(contentsOf: fileURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = object["accountId"] as? String else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let pattern = #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#
        guard value.range(of: pattern, options: .regularExpression) != nil else { return nil }
        return value
    }

    public static func write(_ state: State, accountId: String? = nil) {
        var payload: [String: Any] = ["state": state.rawValue]
        if let accountId {
            let value = accountId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            payload["v"] = 2
            payload["accountId"] = value
        } else {
            payload["v"] = 1
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        try? data.write(to: fileURL, options: [.atomic])
        var mutable = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
    }

    public static func abandonPrepared() {
        guard readState() == .prepared else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }

    public static func clear() { try? FileManager.default.removeItem(at: fileURL) }

    /// Launch/sign-in retry: wipe only when already confirmed — never promote prepared/sent.
    /// `wipe(accountId)` receives the marker account id (nil for v1 → caller may clearAll).
    @MainActor
    public static func retryPurge(wipe: (_ accountId: String?) throws -> Int) throws -> Bool {
        guard readState() == .confirmed else { return false }
        if try wipe(readAccountId()) != 0 { throw NSError(domain: "clinical_purge", code: 1) }
        clear()
        return true
    }
}
