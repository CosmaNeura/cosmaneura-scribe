import AVFoundation
import CoreMedia
import CryptoKit
import Foundation
import Testing

@testable import ScribeDesktopAudio

// Opt-in, generated speech only. The operator records consent and fixture hashes
// before this test reads audio. No OS capture or permission API is called.
@Test(
  .enabled(
    if: ProcessInfo.processInfo.environment["SCRIBE_SYNTHETIC_SPEECH_DIRECTORY"] != nil,
    "Run scripts/check-desktop-synthetic-voices.py for generated speech qualification"),
  arguments: [48_000, 32_000]
)
func generatedSpeechSurvivesNativeMeetingMix(systemRate: Int) async throws {
  let path = try #require(ProcessInfo.processInfo.environment["SCRIBE_SYNTHETIC_SPEECH_DIRECTORY"])
  let root = URL(fileURLWithPath: path, isDirectory: true)
  let decoder = JSONDecoder()
  decoder.keyDecodingStrategy = .convertFromSnakeCase
  let consent = try decoder.decode(
    SpeechConsent.self,
    from: Data(contentsOf: root.appendingPathComponent("synthetic-consent.json")))
  try #require(
    consent.schema == 1 && consent.generator == "macos-say-synthetic-v1"
      && consent.syntheticOnly && consent.allPartiesConsented)
  let provider = try speech(root, "provider.caf", rate: 44_100, consent: consent)
  let patient = try speech(root, "patient-\(systemRate).caf", rate: systemRate, consent: consent)
  try #require(
    consent.files["provider.caf"]?.voice != consent.files["patient-\(systemRate).caf"]?.voice)
  let slot =
    Int(ceil(max(Double(provider.count) / 44_100, Double(patient.count) / Double(systemRate)))) + 1
  try #require((2...16).contains(slot))
  // Provider alone, patient alone, then simultaneous speech. Source frames are
  // the same AVFoundation buffers/AudioOutput.frame path used by OS callbacks.
  let microphone = timeline(provider, rate: 44_100, slot: slot, starts: [0, 2])
  let system = timeline(patient, rate: systemRate, slot: slot, starts: [1, 2])
  let mixed = try await mix(microphone, system, systemRate: systemRate, reverse: false)
  let reversed = try await mix(microphone, system, systemRate: systemRate, reverse: true)
  // Half-second renewals cross each isolated voice and simultaneous speech.
  // Compare every output sample with the unrenewed timeline, not only energy.
  let renewed = try await mix(
    microphone, system, systemRate: systemRate, reverse: false, renewEveryTicks: 50)
  let renewedReversed = try await mix(
    microphone, system, systemRate: systemRate, reverse: true, renewEveryTicks: 50)
  let renewalPreservesSpeech = mixed == renewed && mixed == renewedReversed
  #expect(renewalPreservesSpeech, "Renewal must not drop, duplicate or alter spoken samples")
  let microphoneOnly = try await mix(
    microphone, Array(repeating: 0, count: system.count), systemRate: systemRate, reverse: false)
  let systemOnly = try await mix(
    Array(repeating: 0, count: microphone.count), system, systemRate: systemRate, reverse: false)
  let sameOrderIndependentOutput = mixed == reversed
  #expect(sameOrderIndependentOutput, "Callback arrival order must not change spoken samples")
  #expect(mixed.count == slot * 3 * 16_000)
  let providerOnlyRange = 0..<(slot * 16_000)
  let patientOnlyRange = (slot * 16_000)..<(2 * slot * 16_000)
  let overlapRange = (2 * slot * 16_000)..<(3 * slot * 16_000)
  let providerPreserved = mixed[providerOnlyRange].elementsEqual(microphoneOnly[providerOnlyRange])
  let patientPreserved = mixed[patientOnlyRange].elementsEqual(systemOnly[patientOnlyRange])
  #expect(providerPreserved && patientPreserved)
  // Independent conservation check: neither voice may disappear during overlap.
  // Separate PCM16 quantization can differ by one integer unit when summed.
  let sumPreserved = overlapRange.allSatisfy {
    abs(Int(mixed[$0]) - Int(microphoneOnly[$0]) - Int(systemOnly[$0])) <= 1
  }
  #expect(sumPreserved)
  #expect(energy(microphoneOnly[overlapRange]) > 0.00001)
  #expect(energy(systemOnly[overlapRange]) > 0.00001)
  #expect(energy(mixed[providerOnlyRange]) > 0.00001)
  #expect(energy(mixed[patientOnlyRange]) > 0.00001)
  #expect(
    mixed.allSatisfy { abs(Int($0)) < 32_767 }, "Speech must retain headroom without clipping")
}

private struct SpeechConsent: Decodable {
  let schema: Int
  let generator: String
  let syntheticOnly: Bool
  let allPartiesConsented: Bool
  let files: [String: File]
  struct File: Decodable {
    let sha256: String
    let sampleRate: Int
    let voice: String
  }
}

private func speech(_ root: URL, _ name: String, rate: Int, consent: SpeechConsent) throws
  -> [Float]
{
  let file = root.appendingPathComponent(name)
  let expected = try #require(consent.files[name])
  try #require(expected.sampleRate == rate)
  let bytes = try Data(contentsOf: file)
  try #require(bytes.count > 1_024 && bytes.count < 8_000_000)
  let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  try #require(digest == expected.sha256)
  let audio = try AVAudioFile(forReading: file)
  try #require(
    audio.processingFormat.sampleRate == Double(rate) && audio.processingFormat.channelCount == 1)
  try #require(audio.length > 0 && audio.length <= rate * 15)
  let buffer = try #require(
    AVAudioPCMBuffer(
      pcmFormat: audio.processingFormat, frameCapacity: AVAudioFrameCount(audio.length)))
  try audio.read(into: buffer)
  let values = Array(
    UnsafeBufferPointer(
      start: try #require(buffer.floatChannelData)[0], count: Int(buffer.frameLength)))
  try #require(values.allSatisfy(\.isFinite) && values.contains { abs($0) > 0.01 })
  // Synthetic source amplitude is bounded, so the linear conservation check is
  // not confounded by deliberate input clipping in the production converter.
  let peak = max(0.01, values.map { abs($0) }.max() ?? 0)
  return values.map { $0 * 0.7 / peak }
}

private func timeline(_ samples: [Float], rate: Int, slot: Int, starts: [Int]) -> [Float] {
  var result = [Float](repeating: 0, count: rate * slot * 3)
  for start in starts {
    result.replaceSubrange(
      (start * slot * rate)..<(start * slot * rate + samples.count), with: samples)
  }
  return result
}

private final class SpeechSink: DesktopPCMSink, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Int16] = []
  private var failures: [DesktopAudioFailure] = []
  private var packets: [DesktopPCMPacket] = []
  private var starts = 0
  func started(_ start: DesktopPCMStart) -> Bool {
    lock.withLock { starts += 1 }
    return true
  }
  func receive(_ packet: DesktopPCMPacket) -> Bool {
    lock.withLock {
      packets.append(packet)
      packet.withSamples { values.append(contentsOf: $0) }
    }
    return true
  }
  func failed(_ reason: DesktopAudioFailure) { lock.withLock { failures.append(reason) } }
  func result() throws -> [Int16] {
    try lock.withLock {
      try #require(failures.isEmpty && starts == 1 && packets.allSatisfy { $0.isClear })
      var position = 0
      for packet in packets {
        try #require(packet.firstFrame == position)
        position += packet.frameCount
      }
      try #require(position == values.count)
      return values
    }
  }
}

private func mix(
  _ microphone: [Float], _ system: [Float], systemRate: Int, reverse: Bool,
  renewEveryTicks: Int? = nil
)
  async throws -> [Int16]
{
  let sink = SpeechSink()
  let expected = microphone.count * 16_000 / 44_100
  let initialLimit = renewEveryTicks.map { min(expected, $0 * 2 * 160) } ?? expected
  let mixer = try AlignedMeetingPCM(
    maximumOutputFrames: initialLimit, hardMaximumOutputFrames: expected, sink: sink)
  let delivery = AudioDelivery(sink: mixer, onFailure: { _ in })
  let channels = systemRate == 48_000 ? 2 : 1
  var renewals = 0
  for tick in 0..<(microphone.count / 441) {
    if let interval = renewEveryTicks, tick > 0, tick.isMultiple(of: interval) {
      try mixer.extend(maximumOutputFrames: min(expected, (tick + interval * 2) * 160))
      renewals += 1
    }
    let time = CMTime(value: Int64(1_000_000_000 + tick * 10_000_000), timescale: 1_000_000_000)
    let mic = try frame(
      microphone, at: tick * 441, rate: 44_100, channels: 1, channel: .microphone, time: time)
    let remote = try frame(
      system, at: tick * (systemRate / 100), rate: systemRate, channels: channels,
      channel: .systemAudio, time: time)
    for input in reverse ? [remote, mic] : [mic, remote] { delivery.offer(input) }
    await delivery.drain()
    try #require(mic.isClear && remote.isClear)
  }
  delivery.seal()
  await delivery.drain()
  let finished = try mixer.finish()
  if renewEveryTicks != nil { #expect(renewals > 0) }
  #expect(finished.outputFrames == expected)
  #expect(finished.microphoneTailNanoseconds == 0 && finished.systemTailNanoseconds == 0)
  return try sink.result()
}

private func frame(
  _ samples: [Float], at position: Int, rate: Int, channels: Int,
  channel: DesktopAudioChannel, time: CMTime
) throws -> DesktopAudioFrame {
  let count = rate / 100
  let format = try #require(
    AVAudioFormat(
      standardFormatWithSampleRate: Double(rate), channels: AVAudioChannelCount(channels)))
  let buffer = try #require(
    AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)))
  buffer.frameLength = AVAudioFrameCount(count)
  let data = try #require(buffer.floatChannelData)
  for c in 0..<channels { for i in 0..<count { data[c][i] = samples[position + i] } }
  return try AudioOutput.frame(
    buffer, channel: channel, time: time, sourceSamplePosition: Int64(position))
}

private func energy(_ samples: ArraySlice<Int16>) -> Double {
  samples.reduce(0) { $0 + pow(Double($1) / 32_768, 2) } / Double(samples.count)
}
