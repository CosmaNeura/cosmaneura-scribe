import Foundation

public enum ClinicalPurgeMarker {
    public enum State: String { case prepared, sent, confirmed }

    private static let uuidPattern =
        #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#

    private static var fileURL: URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = root.appendingPathComponent("CosmaneuraClinicalPurge", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        excludeFromBackup(dir)
        return dir.appendingPathComponent("clinical-purge-pending-v1.json")
    }

    private static func excludeFromBackup(_ url: URL) {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try? mutable.setResourceValues(values)
    }

    private static func normalizedAccountId(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.range(of: uuidPattern, options: .regularExpression) != nil else { return nil }
        return value
    }

    public static var exists: Bool { FileManager.default.fileExists(atPath: fileURL.path) }

    private static func readObject() -> [String: Any]? {
        guard let data = try? Data(contentsOf: fileURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object
    }

    public static func readState() -> State? {
        guard let raw = readObject()?["state"] as? String else { return nil }
        return State(rawValue: raw)
    }

    public static func readVersion() -> Int? {
        readObject()?["v"] as? Int
    }

    public static func readAccountId() -> String? {
        guard let raw = readObject()?["accountId"] as? String else { return nil }
        return normalizedAccountId(raw)
    }

    public static func hasAccountIdKey() -> Bool {
        readObject()?["accountId"] != nil
    }

    public static func write(_ state: State, accountId: String) {
        guard let value = normalizedAccountId(accountId) else { return }
        let payload: [String: Any] = [
            "state": state.rawValue,
            "v": 2,
            "accountId": value,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        try? data.write(to: fileURL, options: [.atomic])
        excludeFromBackup(fileURL)
    }

    public static func writeV1(_ state: State) {
        if hasAccountIdKey() { return }
        let payload: [String: Any] = ["state": state.rawValue, "v": 1]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        try? data.write(to: fileURL, options: [.atomic])
        excludeFromBackup(fileURL)
    }

    public static func abandonPrepared() {
        guard readState() == .prepared else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }

    public static func clear() { try? FileManager.default.removeItem(at: fileURL) }

    @MainActor
    public static func retryPurge(wipe: (_ accountId: String?) throws -> Int) throws -> Bool {
        guard readState() == .confirmed else { return false }
        let version = readVersion() ?? 1
        let hasKey = hasAccountIdKey()
        let accountId = readAccountId()

        if version >= 2 || hasKey {
            guard let accountId else {
                throw NSError(
                    domain: "clinical_purge",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "v2_marker_account_unavailable"]
                )
            }
            if try wipe(accountId) != 0 {
                throw NSError(domain: "clinical_purge", code: 1)
            }
            clear()
            return true
        }

        guard version == 1, !hasKey else {
            throw NSError(
                domain: "clinical_purge",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "marker_shape_unavailable"]
            )
        }
        if try wipe(nil) != 0 {
            throw NSError(domain: "clinical_purge", code: 1)
        }
        clear()
        return true
    }
}
