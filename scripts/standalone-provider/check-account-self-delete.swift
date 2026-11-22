import Foundation
import CosmasNativeAuth

enum AccountSelfDeleteCheckFailure: Error { case failed }

func require(_ value: Bool, file: StaticString = #fileID, line: UInt = #line) throws {
    if !value {
        FileHandle.standardError.write(Data("Account self-delete check failed at \(file):\(line)\n".utf8))
        throw AccountSelfDeleteCheckFailure.failed
    }
}

func body(_ status: String, practiceLeftOwnerless: Bool, clerkIdentityRemoved: Bool) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
        "status": status, "practice_left_ownerless": practiceLeftOwnerless,
        "clerk_identity_removed": clerkIdentityRemoved,
    ])
}

func expectDeleted(_ payload: [String: Any]?, status: String) throws {
    // H11: require the three fields; extras on the wire body are ignored upstream.
    try require(payload != nil && payload?["status"] as? String == status
        && payload?["practiceLeftOwnerless"] as? Bool != nil
        && payload?["clerkIdentityRemoved"] as? Bool != nil)
}
func expectFlag(_ payload: [String: Any]?, key: String) throws {
    try require(payload != nil && payload?[key] as? Bool == true && payload!.count == 1)
}

@main
struct CheckAccountSelfDelete {
    static func main() async throws {
        for origin in ["https://staging-app.cosmaneura.com", "https://app.cosmaneura.com",
                       "http://127.0.0.1:8787", "http://localhost:8787"] {
            try require(AccountSelfDeleteContract.allowsCoreOrigin(origin))
        }
        for origin in ["http://127.0.0.1", "http://localhost", "http://evil.example/",
                       "http://127.0.0.1:8787/v1", "http://127.0.0.1:8787?x=1",
                       "https://staging-app.cosmaneura.com.evil", "http://192.168.1.10:8787", "https://example.com"] {
            try require(!AccountSelfDeleteContract.allowsCoreOrigin(origin))
        }
        try require(AccountSelfDeleteContract.accountDeleteURL(origin: "http://evil.example") == nil)
        try require(AccountSelfDeleteContract.makeAuthorizedAccountDeleteRequest(
            origin: "http://evil.example", bearerToken: "synthetic") == nil)
        let allowed = AccountSelfDeleteContract.makeAuthorizedAccountDeleteRequest(
            origin: "https://staging-app.cosmaneura.com", bearerToken: "synthetic")
        try require(allowed?.httpMethod == "DELETE"
            && allowed?.url?.absoluteString == "https://staging-app.cosmaneura.com/v1/me/account"
            && allowed?.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic")
        try require(AccountSelfDeleteContract.coreOrigin(
            forFrontendOrigin: "https://resolved-emu-53.clerk.accounts.dev") == "https://staging-app.cosmaneura.com")
        try require(AccountSelfDeleteContract.coreOrigin(
            forFrontendOrigin: "https://clerk.cosmaneura.com") == "https://app.cosmaneura.com")
        try require(AccountSelfDeleteContract.coreOrigin(forFrontendOrigin: "https://other.clerk.dev") == nil)
        try expectDeleted(AccountSelfDeleteContract.resolve(
            origin: "https://staging-app.cosmaneura.com", statusCode: 200,
            body: try body("deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true)), status: "deleted")
        try expectDeleted(AccountSelfDeleteContract.resolve(
            origin: "https://app.cosmaneura.com", statusCode: 200,
            body: try body("already_deleted", practiceLeftOwnerless: true, clerkIdentityRemoved: true)),
            status: "already_deleted")
        for (code, key) in [(401, "unauthorized"), (410, "gone"), (404, "unavailable"), (503, "retryable")] {
            try expectFlag(AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com", statusCode: code, body: nil), key: key)
        }
        try expectFlag(AccountSelfDeleteContract.bridgePayload(for: .recordingActive), key: "recordingActive")
        for code in [409, 422, 500, 502] {
            try require(AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com", statusCode: code, body: nil) == nil)
        }
        try require(AccountSelfDeleteContract.resolve(
            origin: "https://staging-app.cosmaneura.com", statusCode: 200,
            body: Data(#"{"status":"deleted"}"#.utf8)) == nil)
        try expectDeleted(AccountSelfDeleteContract.resolve(
            origin: "https://staging-app.cosmaneura.com", statusCode: 200,
            body: Data(#"{"status":"deleted","practice_left_ownerless":false,"clerk_identity_removed":true,"extra":1}"#.utf8)),
            status: "deleted")
        try require(AccountSelfDeleteContract.resolve(
            origin: "http://evil.example", statusCode: 200,
            body: try body("deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true)) == nil)
        try expectFlag(AccountSelfDeleteContract.resolve(
            origin: "http://127.0.0.1:8787", statusCode: 404, body: nil), key: "unavailable")

        try await runAttemptChecks()
        FileHandle.standardOutput.write(Data("account-self-delete-ok\n".utf8))
    }
}

@MainActor
final class AttemptCounters {
    var began = 0, ended = 0, sends = 0, prepared = 0, sent = 0, confirmed = 0
    func reset() { began = 0; ended = 0; sends = 0; prepared = 0; sent = 0; confirmed = 0 }
}

@MainActor
func runAttemptChecks() async throws {
    ClinicalPurgeMarker.clear()
    let counts = AttemptCounters()
    let deleted = try body("deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true)
    let clinicalAccountId = "11111111-1111-4111-8111-111111111111"

    func attempt(
        status: Int = 200,
        bodyData: Data? = nil,
        mintThrows: Bool = false,
        accountId: String = clinicalAccountId
    ) async -> [String: Any]? {
        await AccountSelfDeleteContract.attempt(
            holdsOrOpeningRecording: { false },
            origin: "https://staging-app.cosmaneura.com",
            mintToken: {
                if mintThrows { throw URLError(.notConnectedToInternet) }
                return "synthetic"
            },
            send: { req in
                counts.sends += 1
                let data = bodyData ?? deleted
                return (data, HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
            },
            beginDeletion: { counts.began += 1 },
            endDeletion: { counts.ended += 1 },
            markerPrepared: {
                counts.prepared += 1
                if ClinicalPurgeMarker.readState() != .sent {
                    ClinicalPurgeMarker.write(.prepared, accountId: accountId)
                }
            },
            markerSent: {
                counts.sent += 1
                ClinicalPurgeMarker.write(.sent, accountId: accountId)
            },
            markerConfirm: {
                counts.confirmed += 1
                ClinicalPurgeMarker.write(.confirmed, accountId: accountId)
            },
            markerAbandonPrepared: { ClinicalPurgeMarker.abandonPrepared() })
    }

    // B1: offline / mint failure — no wipe, no deleted payload.
    counts.reset(); ClinicalPurgeMarker.clear()
    let offline = await attempt(mintThrows: true)
    try require(offline == nil && counts.sends == 0 && counts.confirmed == 0)
    try require(ClinicalPurgeMarker.readState() != .confirmed)
    try require(ClinicalPurgeMarker.readState() != .sent)

    // B2: same-attempt 401 — unauthorized, never wipe.
    counts.reset(); ClinicalPurgeMarker.clear()
    let unauthorized = await attempt(status: 401)
    try require(unauthorized?["unauthorized"] as? Bool == true)
    try require(counts.sends == 1 && counts.began == 1 && counts.confirmed == 0)
    try require(ClinicalPurgeMarker.readState() != .confirmed)

    counts.reset(); ClinicalPurgeMarker.clear()
    let ok = await attempt(status: 200, bodyData: deleted)
    try require(ok?["status"] as? String == "deleted")
    try require(counts.sends == 1 && counts.began == 1 && counts.ended == 1
        && counts.sent == 1 && counts.confirmed == 1)
    try require(ClinicalPurgeMarker.readState() == .confirmed)
    try require(ClinicalPurgeMarker.readVersion() == 2)
    try require(ClinicalPurgeMarker.readAccountId() == clinicalAccountId)

    ClinicalPurgeMarker.clear()
    ClinicalPurgeMarker.writeV1(.prepared)
    let wipeProbe = AttemptCounters()
    let retried = try ClinicalPurgeMarker.retryPurge { _ in
        wipeProbe.began += 1
        return 0
    }
    try require(retried == false && wipeProbe.began == 0)
    try require(ClinicalPurgeMarker.readState() == .prepared)
    ClinicalPurgeMarker.clear()

    ClinicalPurgeMarker.write(.confirmed, accountId: clinicalAccountId)
    var wipedId: String?
    let v2Retried = try ClinicalPurgeMarker.retryPurge { accountId in
        wipedId = accountId
        return 0
    }
    try require(v2Retried == true && wipedId == clinicalAccountId)
    try require(ClinicalPurgeMarker.readState() == nil)

    let badPayload: [String: Any] = ["state": "confirmed", "v": 2, "accountId": "not-a-uuid"]
    let badData = try JSONSerialization.data(withJSONObject: badPayload)
    let markerURL: URL = {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return root.appendingPathComponent("CosmaneuraClinicalPurge/clinical-purge-pending-v1.json")
    }()
    try? FileManager.default.createDirectory(at: markerURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try badData.write(to: markerURL, options: [.atomic])
    var badWiped = false
    do {
        _ = try ClinicalPurgeMarker.retryPurge { _ in
            badWiped = true
            return 0
        }
        try require(false) // must throw
    } catch {
        try require(!badWiped)
        try require(ClinicalPurgeMarker.readState() == .confirmed)
    }
    ClinicalPurgeMarker.clear()

    ClinicalPurgeMarker.write(.prepared, accountId: clinicalAccountId)
    ClinicalPurgeMarker.writeV1(.sent)
    try require(ClinicalPurgeMarker.readState() == .prepared)
    try require(ClinicalPurgeMarker.readAccountId() == clinicalAccountId)
    ClinicalPurgeMarker.clear()

    // Earlier-attempt sent + definitive later 200 confirms (does not demote sent).
    ClinicalPurgeMarker.write(.sent, accountId: clinicalAccountId)
    counts.reset()
    let recovered = await attempt(status: 200, bodyData: deleted)
    try require(recovered?["status"] as? String == "deleted")
    try require(counts.confirmed == 1 && ClinicalPurgeMarker.readState() == .confirmed)
    try require(ClinicalPurgeMarker.readAccountId() == clinicalAccountId)
    ClinicalPurgeMarker.clear()
}
