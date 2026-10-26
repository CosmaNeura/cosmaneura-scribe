import Foundation
import XCTest
@testable import CosmaneuraNativeRecording

@MainActor final class NativePassageWorkTests: XCTestCase {
  final class Gate: @unchecked Sendable {
    let condition = NSCondition()
    private var started = false, released = false
    func wait() throws {
      condition.lock();defer { condition.unlock() }
      started = true;condition.broadcast()
      let deadline = Date().addingTimeInterval(5)
      while !released {
        guard condition.wait(until: deadline) else { throw CancellationError() }
      }
    }
    var running: Bool { condition.lock();defer { condition.unlock() };return started }
    func release() { condition.lock();released = true;condition.broadcast();condition.unlock() }
  }
  func testMainActorRemainsAvailableWhileNativeStorageWorkRuns() async throws {
    let gate = Gate()
    let task = Task { try await nativePassageWork { try gate.wait();return 7 } }
    for _ in 0..<1000 { if gate.running { break };try await Task.sleep(for: .milliseconds(1)) }
    XCTAssertTrue(gate.running) // This actor resumed while the worker is blocked.
    gate.release();let value = try await task.value;XCTAssertEqual(value, 7)
  }
  func testCancellationWaitsForWorkerSettlementAndRefusesItsLateResult() async throws {
    let gate = Gate()
    let task = Task { try await nativePassageWork { try gate.wait();return 7 } }
    for _ in 0..<1000 { if gate.running { break };try await Task.sleep(for: .milliseconds(1)) }
    XCTAssertTrue(gate.running);task.cancel();gate.release()
    do { _ = try await task.value;XCTFail("Cancelled result escaped") } catch is CancellationError {} catch { XCTFail() }
  }
}
