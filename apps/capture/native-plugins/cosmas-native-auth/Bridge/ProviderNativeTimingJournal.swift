import Foundation

/// Durable, bounded numeric diagnostics for the already-observed native request.
/// This accepts no body, credential, identifier, URL, header, or error string.
/// Writes run off the request path and never change its result or authority.
final class ProviderNativeTimingJournal: @unchecked Sendable {
    static let maximumEntries = 128
    static let maximumBytes = 65_536
    static let maximumPending = 160
    static let shared = ProviderNativeTimingJournal(destination:
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("scribe-provider-timing-v1.json"))

    private struct Entry: Encodable, Sendable {
        let version = 1
        let clock = "dispatch-uptime-ns"
        let monotonic_ns: String
        let utc: Date
        let action: String
        let token_ms: Int
        let receiver_ms: Int?
        let total_ms: Int
        let status: Int?
        let completed: Bool
        let server_ms: [String: Double]?
        let core_ms: [String: Double]?
        let core_response_start_only: Bool?
        let core_nonadditive: Bool?
        let dropped_events: Int
    }

    private let destination: URL?
    private let queue: DispatchQueue
    private let admission = NSLock()
    private var pending = 0
    private var dropped = 0
    private var entries: [Entry] = []

    init(destination: URL?, queue: DispatchQueue = DispatchQueue(
        label: "com.cosmaneura.scribe.provider-timing-journal")) {
        self.destination = destination?.isFileURL == true ? destination : nil
        self.queue = queue
    }

    func record(_ timing: ProviderNativeRequestTiming) {
        let durations = [timing.tokenMilliseconds, timing.totalMilliseconds]
            + (timing.receiverMilliseconds.map { [$0] } ?? [])
        guard durations.allSatisfy({ (0...3_600_000).contains($0) }),
            timing.status.map({ (100...599).contains($0) }) ?? true else { return }
        let server = timing.serverTiming.map { value in
            Dictionary(uniqueKeysWithValues: ProviderServerTiming.Phase.allCases.map {
                ($0.rawValue, value.milliseconds($0))
            })
        }
        let core = timing.coreTiming.map { value in
            Dictionary(uniqueKeysWithValues: ProviderCoreTiming.Phase.allCases.map {
                ($0.rawValue, value.measurement($0).milliseconds)
            })
        }
        guard (server?.values.allSatisfy { $0.isFinite && (0...3_600_000).contains($0) } ?? true),
            (core?.values.allSatisfy { $0.isFinite && (0...9_600_000).contains($0) } ?? true)
            else { return }
        admission.withLock {
            guard let target = destination else { return }
            guard pending < Self.maximumPending else {
                dropped = min(2_147_483_647, dropped + 1); return
            }
            pending += 1
            let entry = Entry(monotonic_ns: String(DispatchTime.now().uptimeNanoseconds),
                utc: Date(), action: timing.action.rawValue,
                token_ms: timing.tokenMilliseconds, receiver_ms: timing.receiverMilliseconds,
                total_ms: timing.totalMilliseconds, status: timing.status, completed: timing.completed,
                server_ms: server, core_ms: core, core_response_start_only: core == nil ? nil : true,
                core_nonadditive: core == nil ? nil : true, dropped_events: dropped)
            queue.async { [self] in
                defer { admission.withLock { pending -= 1 } }
                entries.append(entry)
                if entries.count > Self.maximumEntries {
                    entries.removeFirst(entries.count - Self.maximumEntries)
                }
                do {
                    let encoder = JSONEncoder()
                    encoder.dateEncodingStrategy = .custom { date, encoder in
                        let formatter = ISO8601DateFormatter()
                        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                        var value = encoder.singleValueContainer()
                        try value.encode(formatter.string(from: date))
                    }
                    var bytes = try encoder.encode(entries)
                    while bytes.count > Self.maximumBytes && entries.count > 1 {
                        entries.removeFirst(); bytes = try encoder.encode(entries)
                    }
                    guard bytes.count <= Self.maximumBytes else { return }
                    try bytes.write(to: target, options: .atomic)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
                    var url = target
                    var values = URLResourceValues(); values.isExcludedFromBackup = true
                    try url.setResourceValues(values)
                } catch { /* Diagnostic failure must not affect the request. */ }
            }
        }
    }

    func flush() async {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume() }
        }
    }
}
