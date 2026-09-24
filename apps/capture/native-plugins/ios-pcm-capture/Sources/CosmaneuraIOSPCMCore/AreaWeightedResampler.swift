import Foundation

/// Streaming `area-weighted-v1`: each source frame is constant over its
/// rational sample period, matching the capture web client's committed rule.
struct AreaWeightedPCM16Resampler {
  private let sourceRate: Int64
  private let targetRate: Int64
  private var maximumInputFrames: Int64
  private var maximumOutputFrames: Int64
  private var inputFrames: Int64 = 0
  private var outputFrames: Int64 = 0
  private var outputTicksRemaining: Int64
  private var weightedTotal = 0.0
  private var weightedTicks: Int64 = 0
  private var closed = false

  init(sourceRate: Int, targetRate: Int, maximumOutputFrames: Int) throws {
    guard sourceRate >= targetRate,
      sourceRate <= 384_000,
      targetRate > 0,
      maximumOutputFrames >= 0,
      maximumOutputFrames <= Int.max / sourceRate
    else { throw PCMFailure(.invalidPCM) }
    self.sourceRate = Int64(sourceRate)
    self.targetRate = Int64(targetRate)
    self.maximumOutputFrames = Int64(maximumOutputFrames)
    self.maximumInputFrames =
      Int64(maximumOutputFrames) * Int64(sourceRate)
      / Int64(targetRate) + Int64(sourceRate)
    self.outputTicksRemaining = Int64(sourceRate)
  }

  mutating func extendMaximumOutputFrames(_ maximum: Int) throws {
    guard !closed, maximum >= maximumOutputFrames, maximum <= Int.max / Int(sourceRate)
    else { throw PCMFailure(.invalidConfiguration) }
    maximumOutputFrames = Int64(maximum)
    maximumInputFrames = Int64(maximum) * sourceRate / targetRate + sourceRate
  }

  mutating func push(_ input: [Float]) throws -> [Int16] {
    guard !closed else { throw PCMFailure(.invalidPCM) }
    let nextInput = inputFrames + Int64(input.count)
    guard nextInput <= maximumInputFrames else { throw PCMFailure(.outputLimitExceeded) }
    let expectedOutput = nextInput * targetRate / sourceRate
    guard expectedOutput <= maximumOutputFrames else {
      throw PCMFailure(.outputLimitExceeded)
    }
    guard input.allSatisfy(\.isFinite) else { throw PCMFailure(.invalidPCM) }

    var output: [Int16] = []
    output.reserveCapacity(Int(expectedOutput - outputFrames))
    for raw in input {
      let sample = Double(max(-1, min(1, raw)))
      var inputTicksRemaining = targetRate
      while inputTicksRemaining > 0 {
        let overlap = min(inputTicksRemaining, outputTicksRemaining)
        weightedTotal += sample * Double(overlap)
        weightedTicks += overlap
        inputTicksRemaining -= overlap
        outputTicksRemaining -= overlap
        if outputTicksRemaining == 0 {
          output.append(Self.quantize(weightedTotal / Double(weightedTicks)))
          outputFrames += 1
          outputTicksRemaining = sourceRate
          weightedTotal = 0
          weightedTicks = 0
        }
      }
      inputFrames += 1
    }
    guard outputFrames == expectedOutput else {
      for index in output.indices { output[index] = 0 }
      throw PCMFailure(.invalidPCM)
    }
    return output
  }

  mutating func finish() throws -> [Int16] {
    guard !closed else { throw PCMFailure(.invalidPCM) }
    closed = true
    guard weightedTicks > 0 else { return [] }
    let expected = (inputFrames * targetRate + sourceRate - 1) / sourceRate
    guard expected <= maximumOutputFrames else { throw PCMFailure(.outputLimitExceeded) }
    let sample = Self.quantize(weightedTotal / Double(weightedTicks))
    weightedTotal = 0
    weightedTicks = 0
    outputFrames += 1
    guard outputFrames == expected else { throw PCMFailure(.invalidPCM) }
    return [sample]
  }

  mutating func discard() {
    weightedTotal = 0
    weightedTicks = 0
    closed = true
  }

  private static func quantize(_ value: Double) -> Int16 {
    let bounded = max(-1, min(1, value))
    let scaled = bounded < 0 ? bounded * 32_768 : bounded * 32_767
    return Int16(clamping: Int(floor(scaled + 0.5)))
  }
}

struct PCMAccumulator {
  private(set) var storage: [UInt8]
  private(set) var count = 0

  init(frameCapacity: Int) {
    storage = Array(repeating: 0, count: frameCapacity * 2)
  }

  var isFull: Bool { count == storage.count }
  var isEmpty: Bool { count == 0 }

  mutating func append(_ samples: [Int16], range: Range<Int>) throws {
    guard range.lowerBound >= 0,
      range.upperBound <= samples.count,
      range.count <= (storage.count - count) / 2
    else {
      throw PCMFailure(.bufferOverflow)
    }
    for index in range {
      let sample = samples[index]
      let bits = UInt16(bitPattern: sample)
      storage[count] = UInt8(truncatingIfNeeded: bits)
      storage[count + 1] = UInt8(truncatingIfNeeded: bits >> 8)
      count += 2
    }
  }

  mutating func takeFull() -> OwnedPCMBytes {
    precondition(isFull)
    let transferred = storage
    storage = Array(repeating: 0, count: transferred.count)
    count = 0
    return OwnedPCMBytes(transferred)
  }

  mutating func takePartial() -> OwnedPCMBytes? {
    guard count > 0 else { return nil }
    let transferred = Array(storage[..<count])
    zeroize()
    return OwnedPCMBytes(transferred)
  }

  mutating func zeroize() {
    for index in storage.indices { storage[index] = 0 }
    count = 0
  }
}
