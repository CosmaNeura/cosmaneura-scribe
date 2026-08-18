import CryptoKit
import Foundation

struct SecureQueueRecord: Equatable {
    let key: String
    let data: Data
    let revision: UInt64
}

enum SecureQueueRecordCodec {
    static let maximumKeyBytes = 512
    static let maximumRevision = UInt64(Int64.max)

    static func validatedKeyData(_ key: String) throws -> Data {
        guard
            !key.isEmpty,
            let keyData = key.data(using: .utf8),
            keyData.count <= maximumKeyBytes
        else {
            throw SecureQueueError.invalidArgument
        }
        return keyData
    }

    static func encode(key: String, data: Data, revision: UInt64) throws -> Data {
        let keyData = try validatedKeyData(key)
        guard revision > 0, revision <= maximumRevision else {
            throw SecureQueueError.invalidArgument
        }
        var encodedRevision = revision.bigEndian
        var keyLength = UInt32(keyData.count).bigEndian
        var encoded = Data(
            capacity: MemoryLayout<UInt64>.size + MemoryLayout<UInt32>.size + keyData.count + data.count
        )
        withUnsafeBytes(of: &encodedRevision) { encoded.append(contentsOf: $0) }
        withUnsafeBytes(of: &keyLength) { encoded.append(contentsOf: $0) }
        encoded.append(keyData)
        encoded.append(data)
        return encoded
    }

    static func decode(_ encoded: Data) throws -> SecureQueueRecord {
        let headerBytes = MemoryLayout<UInt64>.size + MemoryLayout<UInt32>.size
        guard encoded.count >= headerBytes else {
            throw SecureQueueError.corrupt
        }
        let revision = encoded.prefix(MemoryLayout<UInt64>.size).reduce(0) {
            ($0 << 8) | UInt64($1)
        }
        let keyLength = encoded[
            MemoryLayout<UInt64>.size..<headerBytes
        ].reduce(0) {
            ($0 << 8) | UInt32($1)
        }
        guard
            revision > 0,
            revision <= maximumRevision,
            keyLength > 0,
            keyLength <= UInt32(maximumKeyBytes),
            Int(keyLength) <= encoded.count - headerBytes
        else {
            throw SecureQueueError.corrupt
        }
        let keyStart = headerBytes
        let keyEnd = keyStart + Int(keyLength)
        guard let key = String(data: encoded[keyStart..<keyEnd], encoding: .utf8) else {
            throw SecureQueueError.corrupt
        }
        return SecureQueueRecord(
            key: key,
            data: Data(encoded[keyEnd...]),
            revision: revision
        )
    }

    static func digest(for key: String) throws -> Data {
        Data(SHA256.hash(data: try validatedKeyData(key)))
    }

    static func filename(for digest: Data) throws -> String {
        guard digest.count == SHA256.byteCount else {
            throw SecureQueueError.corrupt
        }
        return digest.map { String(format: "%02x", $0) }.joined() + ".sq"
    }

    static func digest(fromFilename filename: String) throws -> Data {
        guard filename.hasSuffix(".sq") else {
            throw SecureQueueError.corrupt
        }
        let hex = String(filename.dropLast(3))
        guard hex.count == SHA256.byteCount * 2 else {
            throw SecureQueueError.corrupt
        }
        var digest = Data(capacity: SHA256.byteCount)
        var cursor = hex.startIndex
        for _ in 0..<SHA256.byteCount {
            let next = hex.index(cursor, offsetBy: 2)
            guard let byte = UInt8(hex[cursor..<next], radix: 16) else {
                throw SecureQueueError.corrupt
            }
            digest.append(byte)
            cursor = next
        }
        return digest
    }
}
