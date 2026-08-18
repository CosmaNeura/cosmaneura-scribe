import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(supportDirectory, "../fixtures");
const manifestPath = join(fixtureDirectory, "synthetic-pcm16-mono-16khz.json");

export function materializeSyntheticAudioFixture() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  fixed(manifest.schema_version === "1.0", "synthetic_audio_manifest_version_invalid");
  fixed(manifest.source_kind === "synthetic", "synthetic_audio_source_kind_invalid");
  fixed(manifest.deidentified === true, "synthetic_audio_must_be_deidentified");
  fixed(manifest.encoded_file === "synthetic-pcm16-mono-16khz.wav.b64", "synthetic_audio_file_invalid");

  const encoded = readFileSync(join(fixtureDirectory, manifest.encoded_file), "utf8")
    .replaceAll(/\s/gu, "");
  const wav = Buffer.from(encoded, "base64");
  fixed(wav.toString("base64") === encoded, "synthetic_audio_base64_invalid");
  fixed(
    createHash("sha256").update(wav).digest("hex") === manifest.sha256,
    "synthetic_audio_digest_mismatch",
  );
  assertPcm16MonoWav(wav, manifest);

  const runtimeDirectory = mkdtempSync(join(tmpdir(), "cosmaneura-capture-e2e-"));
  const runtimePath = join(runtimeDirectory, "synthetic-pcm16-mono-16khz.wav");
  writeFileSync(runtimePath, wav, { mode: 0o600 });
  return runtimePath;
}

function assertPcm16MonoWav(wav, manifest) {
  fixed(wav.length >= 44, "synthetic_audio_wav_too_short");
  fixed(wav.toString("ascii", 0, 4) === "RIFF", "synthetic_audio_riff_invalid");
  fixed(wav.readUInt32LE(4) + 8 === wav.length, "synthetic_audio_riff_size_invalid");
  fixed(wav.toString("ascii", 8, 12) === "WAVE", "synthetic_audio_wave_invalid");
  fixed(wav.toString("ascii", 12, 16) === "fmt ", "synthetic_audio_fmt_invalid");
  fixed(wav.readUInt16LE(20) === 1, "synthetic_audio_must_be_pcm");
  fixed(wav.readUInt16LE(22) === manifest.channels, "synthetic_audio_channels_invalid");
  fixed(wav.readUInt32LE(24) === manifest.sample_rate_hz, "synthetic_audio_rate_invalid");
  fixed(wav.readUInt16LE(34) === manifest.sample_width_bytes * 8, "synthetic_audio_width_invalid");
  fixed(wav.toString("ascii", 36, 40) === "data", "synthetic_audio_data_chunk_invalid");
  fixed(wav.readUInt32LE(40) === wav.length - 44, "synthetic_audio_data_size_invalid");
  const frames = wav.readUInt32LE(40) / (manifest.channels * manifest.sample_width_bytes);
  fixed(
    frames * 1_000 / manifest.sample_rate_hz === manifest.duration_ms,
    "synthetic_audio_duration_invalid",
  );
}

function fixed(condition, code) {
  if (!condition) throw new Error(code);
}
