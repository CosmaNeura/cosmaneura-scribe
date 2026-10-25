// Serialized into an owned browser context. Output goes only to generated
// microphone tracks; never to speakers or a physical microphone.
export function syntheticMedia(initialFixture) {
  const Audio = window.AudioContext || window.webkitAudioContext;
  const ctx = new Audio({sampleRate: 16000});
  const tracks = new Set();
  const epoch = () => performance.timeOrigin + performance.now();
  function decode({base64, sampleRate, frames, sha256}) {
    if (sampleRate !== 16000 || !Number.isInteger(frames) || frames <= 0 || frames > 16_000_000
        || typeof base64 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('fixture-invalid');
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (bytes.length !== frames * 2) throw Error('fixture-size');
    const pcm = new DataView(bytes.buffer), result = ctx.createBuffer(1, frames, sampleRate);
    const channel = result.getChannelData(0);
    try { for (let i = 0; i < frames; i++) channel[i] = pcm.getInt16(i * 2, true) / 32768; }
    finally { bytes.fill(0); }
    return result;
  }
  let buffer = decode(initialFixture), fixtureSha256 = initialFixture.sha256;
  const destination = ctx.createMediaStreamDestination();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
  const gain = ctx.createGain(); gain.gain.value = 0;
  gain.connect(destination); gain.connect(analyser);
  let source = null, offset = 0, startedAt = null, playing = false, completed = false;
  let calls = 0, audioCalls = 0, clock = null, firstSignal = null, monitor = null;
  const samples = new Float32Array(analyser.fftSize);
  function rms() {
    analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  }
  function position() {
    return playing ? Math.min(buffer.duration, offset + Math.max(0, ctx.currentTime - startedAt)) : offset;
  }
  function stopSource() {
    clearInterval(monitor); monitor = null;
    if (source) { source.onended = null; source.stop(); source.disconnect(); source = null; }
  }
  function report() {
    const output = ctx.getOutputTimestamp?.();
    return {kind: 'synthetic-media', fixtureSha256, playing, completed, offsetSeconds: position(),
      durationSeconds: buffer.duration, contextState: ctx.state, rms: rms(), mediaRequests: calls, audioRequests: audioCalls,
      streamId: destination.stream.id, tracks: [...tracks].map(t => ({id: t.id, state: t.readyState, enabled: t.enabled})),
      audioContextSeconds: ctx.currentTime, observedAtEpochMs: epoch(), outputTimestamp: output ?? null,
      scheduledClock: clock, firstSignal, physicalMedia: false, speakerOutput: false};
  }
  async function schedule({fixtureSha256: expected, startAtEpochMs, restart = false}) {
    if (expected !== fixtureSha256) throw Error('fixture-changed');
    if (playing) throw Error('already-playing');
    if (!restart && (completed || offset <= 0 || offset >= buffer.duration)) throw Error('not-paused');
    if (restart && (offset !== 0 || completed)) throw Error('already-started');
    await ctx.resume();
    if (ctx.state !== 'running') throw Error('audio-context-not-running');
    const sampleEpochMs = epoch(), sampleContextSeconds = ctx.currentTime;
    if (!Number.isFinite(startAtEpochMs) || startAtEpochMs < sampleEpochMs + 50 || startAtEpochMs > sampleEpochMs + 10_000) throw Error('schedule-window');
    startedAt = sampleContextSeconds + (startAtEpochMs - sampleEpochMs) / 1000;
    clock = {sampleEpochMs, sampleContextSeconds, startAtEpochMs, startAtContextSeconds: startedAt, sourceOffsetSeconds: offset};
    firstSignal = null; completed = false;
    source = ctx.createBufferSource(); source.buffer = buffer; source.connect(gain);
    gain.gain.value = 1; playing = true;
    source.onended = () => {
      offset = buffer.duration; playing = false; completed = true; gain.gain.value = 0; source = null;
      clearInterval(monitor); monitor = null;
    };
    source.start(startedAt, offset);
    monitor = setInterval(() => {
      if (firstSignal === null && rms() > 0.005) {
        firstSignal = {observedAtEpochMs: epoch(), audioContextSeconds: ctx.currentTime,
          sourceOffsetSeconds: position(), pollingIntervalMs: 10, analysisFrames: analyser.fftSize};
      }
    }, 10);
    return report();
  }
  function pause() { offset = position(); stopSource(); playing = false; gain.gain.value = 0; return report(); }
  function load(fixture) {
    if (playing) throw Error('source-playing');
    const next = decode(fixture);
    stopSource(); gain.gain.value = 0;
    buffer = next; fixtureSha256 = fixture.sha256; offset = 0; startedAt = null; completed = false; clock = null; firstSignal = null;
    return report();
  }
  function close() { pause(); for (const track of tracks) track.stop(); return ctx.close(); }
  window.__scribeSyntheticMedia = Object.freeze({report, schedule, pause, load, close});
  const devices = navigator.mediaDevices;
  if (!devices) throw Error('media-devices-unavailable');
  const native = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async constraints => {
    if (!constraints?.audio && !constraints?.video) throw TypeError('media-required');
    calls++;
    const stream = new MediaStream();
    if (constraints.audio) {
      audioCalls++; await ctx.resume();
      const track = destination.stream.getAudioTracks()[0].clone(); tracks.add(track); stream.addTrack(track);
    }
    if (constraints.video) {
      const video = await native({video: constraints.video, audio: false});
      for (const track of video.getVideoTracks()) stream.addTrack(track);
    }
    return stream;
  };
}
