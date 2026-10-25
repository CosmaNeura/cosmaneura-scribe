import Foundation

@main struct SessionObservationChecks {
    static func main() throws {
        // Pure synthetic OS dictionaries. No native audio, UI or session action.
        let user: [String: Any] = ["kCGSSessionOnConsoleKey": true, "kCGSSessionUserIDKey": 501,
                                  "kCGSSessionUserNameKey": "administrator", "kCGSessionLoginDoneKey": true]
        let registry: [String: Any] = ["IOConsoleLocked": false, "IOConsoleUsers": [user]]
        var checks = 0
        func assert(_ condition: Bool) throws {
            checks += 1
            if !condition { throw NSError(domain: "SessionObservationCheck", code: checks) }
        }
        func sample(cg: Any? = nil, io: [String: Any]? = registry, uid: Int = 501,
                    name: String? = "administrator", owner: Int? = 501) -> SessionObservation {
            sessionObservation(cgLocked: cg, registry: io, expectedUID: uid, expectedName: name, consoleUID: owner)
        }
        try assert(sample().locked == false)
        try assert(sample().source == "io-registry-and-console-owner")
        try assert(sample(cg: false).locked == false)
        try assert(sample(cg: false).source == "cg-session-and-io-registry")
        try assert(sample(cg: true).locked == nil)
        try assert(sample(cg: NSNumber(value: 0)).locked == nil)
        try assert(sample(cg: "false").locked == nil)
        try assert(sample(cg: NSNull()).locked == nil)
        try assert(sample(io: nil).locked == nil)
        try assert(sample(io: [:]).locked == nil)
        try assert(sample(io: ["IOConsoleLocked": 0, "IOConsoleUsers": [user]]).locked == nil)
        try assert(sample(io: ["IOConsoleLocked": "false", "IOConsoleUsers": [user]]).locked == nil)
        try assert(sample(io: ["IOConsoleLocked": true, "IOConsoleUsers": [user]]).locked == true)
        try assert(sample(cg: false, io: ["IOConsoleLocked": true, "IOConsoleUsers": [user]]).locked == nil)
        try assert(sample(owner: nil).locked == nil)
        try assert(sample(owner: 0).locked == nil)
        try assert(sample(owner: 502).locked == nil)
        try assert(sample(uid: 0, owner: 0).locked == nil)
        try assert(sample(name: nil).locked == nil)
        try assert(sample(name: "another-user").locked == nil)
        try assert(sample(io: ["IOConsoleLocked": false, "IOConsoleUsers": []]).locked == nil)
        try assert(sample(io: ["IOConsoleLocked": false, "IOConsoleUsers": [user, user]]).locked == nil)
        for (key, value) in [("kCGSSessionOnConsoleKey", 1 as Any), ("kCGSSessionOnConsoleKey", "true" as Any),
                             ("kCGSSessionUserIDKey", 502 as Any), ("kCGSSessionUserIDKey", "501" as Any),
                             ("kCGSSessionUserIDKey", true as Any), ("kCGSessionLoginDoneKey", false as Any),
                             ("kCGSessionLoginDoneKey", 1 as Any), ("kCGSSessionUserNameKey", "other" as Any)] {
            var changed = user; changed[key] = value
            try assert(sample(io: ["IOConsoleLocked": false, "IOConsoleUsers": [changed]]).locked == nil)
        }
        var inactive = user; inactive["kCGSSessionOnConsoleKey"] = false
        try assert(sample(io: ["IOConsoleLocked": false, "IOConsoleUsers": [inactive, user]]).locked == false)
        var missing = user; missing.removeValue(forKey: "kCGSessionLoginDoneKey")
        try assert(sample(io: ["IOConsoleLocked": false, "IOConsoleUsers": [missing]]).locked == nil)
        print("{\"passed\":true,\"checks\":\(checks),\"nativeAudioOpened\":false}")
    }
}
