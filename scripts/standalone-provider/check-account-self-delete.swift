import Foundation
import CosmasNativeAuth

/// Offline synthetic checks for the shared T-REL-8a / PR #940 self-delete contract
/// used by both CosmasWorkspaceAuthPlugin.deleteAccount (iPhone) and
/// DesktopProviderMain.deleteAccount (Mac). No network, Keychain, or tokens.
enum AccountSelfDeleteCheckFailure: Error { case failed }

func require(_ value: Bool, file: StaticString = #fileID, line: UInt = #line) throws {
    if !value {
        FileHandle.standardError.write(Data("Account self-delete check failed at \(file):\(line)\n".utf8))
        throw AccountSelfDeleteCheckFailure.failed
    }
}

func body(_ status: String, practiceLeftOwnerless: Bool, clerkIdentityRemoved: Bool) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
        "status": status,
        "practice_left_ownerless": practiceLeftOwnerless,
        "clerk_identity_removed": clerkIdentityRemoved,
    ])
}

func expectDeleted(_ payload: [String: Any]?, status: String) throws {
    try require(payload != nil)
    try require(payload?["status"] as? String == status)
    try require(payload?["practiceLeftOwnerless"] as? Bool != nil)
    try require(payload?["clerkIdentityRemoved"] as? Bool != nil)
    try require(Set(payload!.keys) == ["status", "practiceLeftOwnerless", "clerkIdentityRemoved"])
}

func expectFlag(_ payload: [String: Any]?, key: String) throws {
    try require(payload != nil)
    try require(payload?[key] as? Bool == true)
    try require(payload!.count == 1)
}

@main
struct CheckAccountSelfDelete {
    static func main() throws {
        // Origin allow-list: HTTPS Cosmas + exact localhost:port HTTP only.
        try require(AccountSelfDeleteContract.allowsCoreOrigin("https://staging-app.cosmaneura.com"))
        try require(AccountSelfDeleteContract.allowsCoreOrigin("https://app.cosmaneura.com"))
        try require(AccountSelfDeleteContract.allowsCoreOrigin("http://127.0.0.1:8787"))
        try require(AccountSelfDeleteContract.allowsCoreOrigin("http://localhost:8787"))
        try require(!AccountSelfDeleteContract.allowsCoreOrigin("http://127.0.0.1"))
        try require(!AccountSelfDeleteContract.allowsCoreOrigin("http://localhost"))
        try require(!AccountSelfDeleteContract.allowsCoreOrigin("http://evil.example/"))
        try require(!AccountSelfDeleteContract.allowsCoreOrigin("http://127.0.0.1:8787/v1"))
        try require(!AccountSelfDeleteContract.allowsCoreOrigin("http://127.0.0.1:8787?x=1"))
        try require(!AccountSelfDeleteContract.allowsCoreOrigin("https://staging-app.cosmaneura.com.evil"))
        try require(!AccountSelfDeleteContract.allowsCoreOrigin("http://192.168.1.10:8787"))
        try require(!AccountSelfDeleteContract.allowsCoreOrigin("https://example.com"))

        try require(AccountSelfDeleteContract.coreOrigin(
            forFrontendOrigin: "https://resolved-emu-53.clerk.accounts.dev")
            == "https://staging-app.cosmaneura.com")
        try require(AccountSelfDeleteContract.coreOrigin(
            forFrontendOrigin: "https://clerk.cosmaneura.com")
            == "https://app.cosmaneura.com")
        try require(AccountSelfDeleteContract.coreOrigin(forFrontendOrigin: "https://other.clerk.dev") == nil)

        // Response parsers (same path both native deleteAccount handlers use).
        try expectDeleted(
            AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com",
                statusCode: 200,
                body: try body("deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true)),
            status: "deleted")
        try expectDeleted(
            AccountSelfDeleteContract.resolve(
                origin: "https://app.cosmaneura.com",
                statusCode: 200,
                body: try body("already_deleted", practiceLeftOwnerless: true, clerkIdentityRemoved: true)),
            status: "already_deleted")
        try expectFlag(
            AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com", statusCode: 401, body: nil),
            key: "unauthorized")
        try expectFlag(
            AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com", statusCode: 410, body: nil),
            key: "gone")
        try expectFlag(
            AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com", statusCode: 404, body: nil),
            key: "unavailable")
        try expectFlag(
            AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com", statusCode: 503, body: nil),
            key: "retryable")

        // 409 / 422 / malformed keep-session → rejected (nil payload).
        for code in [409, 422, 500, 502] {
            try require(AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com", statusCode: code, body: nil) == nil)
        }
        try require(AccountSelfDeleteContract.resolve(
            origin: "https://staging-app.cosmaneura.com",
            statusCode: 200,
            body: Data(#"{"status":"deleted"}"#.utf8)) == nil)

        // Forbidden origin never resolves, even on 200 deleted.
        try require(AccountSelfDeleteContract.resolve(
            origin: "http://evil.example",
            statusCode: 200,
            body: try body("deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true)) == nil)
        try require(AccountSelfDeleteContract.resolve(
            origin: "http://127.0.0.1",
            statusCode: 200,
            body: try body("deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true)) == nil)

        // Localhost exact-port path used by sealed local Core still works.
        try expectFlag(
            AccountSelfDeleteContract.resolve(
                origin: "http://127.0.0.1:8787", statusCode: 404, body: nil),
            key: "unavailable")

        FileHandle.standardOutput.write(Data("account-self-delete-ok\n".utf8))
    }
}
