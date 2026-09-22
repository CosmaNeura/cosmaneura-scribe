import Foundation

@main struct TLSCheck {
    static func main() async {
        do { try await run() }
        catch { print("TLS check failed: " + String(describing: error)); exit(1) }
    }
    static func run() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let config = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("runtime.json"))) as! [String: Any]
        let ca = try Data(contentsOf: root.appendingPathComponent("tls/ca.der"))
        let settings: [String: Any] = ["endpoint": config["api_origin"]!, "caDER": ca.base64EncodedString(),
                                       "leafSHA256": config["leaf_der_sha256"]!]
        let transport = try W13PrivateTransport(settings: settings, diagnostic: { print($0) })
        let data = try await transport.read(path: "/connection")
        let result = try JSONSerialization.jsonObject(with: data) as? [String: String]
        guard result == ["connection": "w13-private-read-only"] else { throw W13ConnectionError.response }
        var wrong = settings
        wrong["leafSHA256"] = String(repeating: "0", count: 64)
        do {
            _ = try await W13PrivateTransport(settings: wrong).read(path: "/connection")
            fatalError("An unexpected certificate was accepted")
        } catch W13ConnectionError.connection { }
        var loopback = settings
        loopback["endpoint"] = "https://127.0.0.1:8446"
        do {
            _ = try W13PrivateTransport(settings: loopback)
            fatalError("A loopback phone endpoint was accepted")
        } catch W13ConnectionError.configuration { }
        print("Native private TLS passes; wrong certificate and phone loopback are rejected.")
    }
}
