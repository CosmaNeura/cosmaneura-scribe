import Foundation

/// Pure injected reads only: no defaults domain, SDK, Keychain or service access.
@main struct DesktopStoreClerkAdmissionChecks {
    enum ProtectedRead: Error { case locked, denied, unavailable }

    @MainActor static func main() throws {
        var assertions = 0
        func check(_ value: Bool) {
            precondition(value)
            assertions += 1
        }
        let expected = "com.clerk.trusted-device-installation-marker." +
            "s45:com.cosmaneura.scribe.beta.desktop.auth.clerk.n." +
            "s39:com.cosmaneura.scribe.beta.desktop.auth"
        check(DesktopStoreClerkAdmission.markerKey == expected)
        check(DesktopStoreClerkAdmission.service == "com.cosmaneura.scribe.beta.desktop.auth.clerk")
        check(DesktopStoreClerkAdmission.accessGroup == nil)

        func reject(_ read: (String) throws -> Any?) {
            var driverCalls = 0
            var cleanupCalls = 0
            var accessBlockCalls = 0
            do {
                _ = try DesktopStoreClerkAdmission.construct(
                    appIdentifier: DesktopStoreClerkAdmission.appIdentifier,
                    readMarker: { key in
                        check(key == expected)
                        return try read(key)
                    },
                    makeAuth: {
                        accessBlockCalls += 1
                        driverCalls += 1
                        // Represents a configured SDK's reconciliation side effect.
                        cleanupCalls += 1
                        return 1
                    }
                )
                preconditionFailure("Rejected admission constructed auth")
            } catch DesktopStoreClerkAdmission.Rejection.unavailable {
                check(driverCalls == 0 && cleanupCalls == 0 && accessBlockCalls == 0)
            } catch { preconditionFailure("Unexpected rejection") }
        }
        reject { _ in nil }
        reject { _ in false }
        reject { _ in "true" }
        reject { _ in NSNumber(value: 1) }
        reject { _ in ["marker": true] }
        reject { _ in throw ProtectedRead.locked }
        reject { _ in throw ProtectedRead.denied }
        reject { _ in throw ProtectedRead.unavailable }

        var reads = 0
        var constructions = 0
        do {
            _ = try DesktopStoreClerkAdmission.construct(
                appIdentifier: "com.cosmaneura.scribe.beta",
                readMarker: { _ in reads += 1; return true },
                makeAuth: { constructions += 1; return 1 }
            )
            preconditionFailure("Wrong app identifier admitted")
        } catch DesktopStoreClerkAdmission.Rejection.unavailable {
            check(reads == 0 && constructions == 0)
        }
        let admitted = try DesktopStoreClerkAdmission.construct(
            appIdentifier: DesktopStoreClerkAdmission.appIdentifier,
            readMarker: { key in check(key == expected); reads += 1; return true },
            makeAuth: { constructions += 1; return 42 }
        )
        check(admitted == 42 && reads == 1 && constructions == 1)
        do {
            _ = try DesktopStoreClerkAdmission.construct(
                appIdentifier: DesktopStoreClerkAdmission.appIdentifier,
                readMarker: { _ in true },
                makeAuth: { throw ProtectedRead.denied }
            ) as Int
            preconditionFailure("Construction failure swallowed")
        } catch ProtectedRead.denied { check(true) }
        print("PASS: \(assertions) pure marker-admission assertions")
    }
}
