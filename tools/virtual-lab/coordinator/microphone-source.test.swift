import Foundation
import CryptoKit

@main struct MicrophoneClockChecks {
    static func require(_ condition: Bool) { precondition(condition, "offline microphone clock regression") }
    static func main() throws {
        var pcm = Data()
        for index in 0..<6400 {
            let value: Int16 = index >= 1600 && index < 4800 ? 5000 : 0
            pcm.append(UInt8(truncatingIfNeeded: value)); pcm.append(UInt8(truncatingIfNeeded: value >> 8))
        }
        let hash = String(repeating: "a", count: 64)
        let payload: [String: Any] = ["base64": pcm.base64EncodedString(), "frames": 6400, "sampleRate": 16000,
            "consentRecordId": "synthetic-source-clock-offline-test-consent-20261025",
            "fixtureSha256": hash, "pcmSHA256": SHA256.hash(data: pcm).map { String(format: "%02x", $0) }.joined()]
        let clock = SourceClock(epochOriginMs: 1000000)
        try clock.load(payload)
        var buffer = [Float](repeating: -1, count: 4096)
        func render(_ frames: Int, _ host: Double) {
            buffer.withUnsafeMutableBufferPointer { clock.render($0.baseAddress!, frames: frames, host: host) }
        }
        render(512, 100)
        require(buffer.prefix(512).allSatisfy { $0 == 0 })
        require(clock.report(now: 100)["offsetSeconds"] as? Double == 0)
        try clock.schedule(hash: hash, epochMs: 1100200, restart: true, now: 100)
        render(512, 100.1); require(buffer.prefix(512).allSatisfy { $0 == 0 })
        render(2400, 100.2)
        let started = clock.report(now: 100.35)
        require(started["offsetSeconds"] as? Double == 0.15)
        let first = started["firstSignal"] as! [String: Any]
        require(first["measurement"] as? String == "coreaudio-render-callback")
        require((first["observedAtEpochMs"] as! Double) > 1100300)
        require((first["observedAtEpochMs"] as! Double) < 1100301)
        do { try clock.schedule(hash: hash, epochMs: 1101000, restart: true, now: 100.35); preconditionFailure() } catch { }
        clock.pause(); render(512, 100.4)
        require(buffer.prefix(512).allSatisfy { $0 == 0 })
        let paused = clock.report(now: 101)
        require(paused["offsetSeconds"] as? Double == 0.15); require(paused["playing"] as? Bool == false)
        require(paused["silentFrames"] as! Int >= 512)
        try clock.schedule(hash: hash, epochMs: 1101200, restart: false, now: 101)
        render(4000, 101.2)
        let ended = clock.report(now: 101.5)
        require(ended["completed"] as? Bool == true); require(ended["offsetSeconds"] as? Double == 0.4)
        require((ended["scheduledClock"] as! [String: Any])["sourceOffsetSeconds"] as? Double == 0.15)
        require(ended["nonzeroOutputFrames"] as? Int == 3200)
        clock.fail(); render(512, 102); require(buffer.prefix(512).allSatisfy { $0 == 0 })
        var bad = payload; bad["pcmSHA256"] = String(repeating: "b", count: 64)
        do { try clock.load(bad); preconditionFailure() } catch { }
        print("PASS: actual source-clock code; initial silence, scheduled sample onset, duplicate-start refusal, exact pause offset, resume completion, device-loss silence and PCM hash rejection. Offline only; no AudioUnit or capture opened.")
    }
}
