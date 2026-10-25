import Foundation
import Testing
@testable import CosmaneuraIOSPCMCore

struct PCMByteClearingTests {
  @Test(arguments: [0, 1, 31, 320_000])
  func repeatedClearCoversEveryOwnedByteWithoutChangingLength(_ count: Int) {
    let original = [UInt8](repeating: 165, count: count)
    let owned = OwnedPCMBytes(original)
    owned.zeroize()
    #expect(owned.count == count && owned.isZeroed)
    #expect(owned.withUnsafeBytes { $0.allSatisfy { $0 == 0 } })
    owned.zeroize()
    #expect(owned.count == count && owned.isZeroed)
    // The constructor's value copy preserves other owners, including when the
    // first bulk mutation must make Array storage unique.
    #expect(original.allSatisfy { $0 == 165 })
  }

  @Test func concurrentReadersNeverSeePartiallyClearedStorage() async {
    let owned = OwnedPCMBytes([UInt8](repeating: 165, count: 32_000))
    let outcomes = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
      for _ in 0..<8 {
        group.addTask {
          for _ in 0..<10 {
            let intact = owned.withUnsafeBytes { bytes in
              bytes.allSatisfy { $0 == 0 } || bytes.allSatisfy { $0 == 165 }
            }
            if !intact { return false }
          }
          return true
        }
      }
      group.addTask { for _ in 0..<10 { owned.zeroize() }; return true }
      var values: [Bool] = []
      for await value in group { values.append(value) }
      return values
    }
    #expect(outcomes.count == 9 && outcomes.allSatisfy { $0 })
    #expect(owned.count == 32_000 && owned.isZeroed)
  }
}
