import Foundation
import CosmasNativeAuth

/// Offline synthetic checks for the shared T-REL-8a / PR #940 self-delete contract.
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
    try require(payload != nil && payload?["status"] as? String == status)
    try require(payload?["practiceLeftOwnerless"] as? Bool != nil)
    try require(payload?["clerkIdentityRemoved"] as? Bool != nil)
    try require(Set(payload!.keys) == ["status", "practiceLeftOwnerless", "clerkIdentityRemoved"])
}
func expectFlag(_ payload: [String: Any]?, key: String) throws {
    try require(payload != nil && payload?[key] as? Bool == true && payload!.count == 1)
}

@main
struct CheckAccountSelfDelete {
    static func main() throws {
        try require(AccountSelfDeleteContract.allowsCoreOrigin("https://staging-app.cosmaneura.com"))
        try require(AccountSelfDeleteContract.allowsCoreOrigin("https://app.cosmaneura.com"))
        try require(AccountSelfDeleteContract.allowsCoreOrigin("http://127.0.0.1:8787"))
        try require(AccountSelfDeleteContract.allowsCoreOrigin("http://localhost:8787"))
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
        try require(allowed?.httpMethod == "DELETE")
        try require(allowed?.url?.absoluteString == "https://staging-app.cosmaneura.com/v1/me/account")
        try require(allowed?.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic")
        try require(AccountSelfDeleteContract.coreOrigin(
            forFrontendOrigin: "https://resolved-emu-53.clerk.accounts.dev")
            == "https://staging-app.cosmaneura.com")
        try require(AccountSelfDeleteContract.coreOrigin(
            forFrontendOrigin: "https://clerk.cosmaneura.com") == "https://app.cosmaneura.com")
        try require(AccountSelfDeleteContract.coreOrigin(forFrontendOrigin: "https://other.clerk.dev") == nil)
        try expectDeleted(
            AccountSelfDeleteContract.resolve(
                origin: "https://staging-app.cosmaneura.com", statusCode: 200,
                body: try body("deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true)),
            status: "deleted")
        try expectDeleted(
            AccountSelfDeleteContract.resolve(
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
        try require(AccountSelfDeleteContract.resolve(
            origin: "http://evil.example", statusCode: 200,
            body: try body("deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true)) == nil)
        try expectFlag(AccountSelfDeleteContract.resolve(
            origin: "http://127.0.0.1:8787", statusCode: 404, body: nil), key: "unavailable")
        FileHandle.standardOutput.write(Data("account-self-delete-ok\n".utf8))
    }
}
