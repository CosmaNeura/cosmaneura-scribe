import {readFile, lstat, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, basename} from 'node:path';

export const hash = data => createHash('sha256').update(data).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validated = new WeakSet();
export function requireValidatedFixture(value) {
  if (!validated.has(value)) throw Error('fixture-not-validated');
  return value;
}
async function read(path, maximum = 32_000_000) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw Error('invalid-file');
  return readFile(path);
}

// Registry pins are reviewed separately from the external generated audio. No
// machine-specific fixture paths or unvalidated arbitrary WAVs are accepted.
export async function openFixtureRegistry({root, registryPath, registrySha256}) {
  const bytes = await read(registryPath, 100_000);
  if (!validHash(registrySha256) || hash(bytes) !== registrySha256) throw Error('registry-mismatch');
  const registry = JSON.parse(bytes);
  if (registry.schema !== 1 || !registry.cases || Array.isArray(registry.cases)) throw Error('registry-invalid');
  const directory = await realpath(root);
  return Object.freeze({
    async load({caseId, file = 'visit.wav'}) {
      if (typeof caseId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(caseId)
          || !Object.hasOwn(registry.cases, caseId) || !validHash(registry.cases[caseId])
          || basename(file) !== file || !/^[a-z0-9][a-z0-9-]*\.wav$/.test(file)) throw Error('fixture-not-allowed');
      const folder = resolve(directory, caseId);
      if (await realpath(folder) !== folder) throw Error('fixture-not-allowed');
      const manifestBytes = await read(resolve(folder, 'manifest.json'), 1_000_000);
      if (hash(manifestBytes) !== registry.cases[caseId]) throw Error('manifest-mismatch');
      const manifest = JSON.parse(manifestBytes);
      // Consent is authenticated before the first read of audio or ground truth.
      const consentBytes = await read(resolve(folder, 'consent.json'), 100_000);
      if (!validHash(manifest.consent_sha256) || hash(consentBytes) !== manifest.consent_sha256) throw Error('consent-mismatch');
      const consent = JSON.parse(consentBytes);
      if (manifest.case_id !== caseId || manifest.synthetic_only !== true || manifest.all_parties_consented !== true
          || consent.synthetic_only !== true || consent.all_parties_consented !== true || consent.case_id !== caseId
          || !consent.consent_record_id || consent.consent_record_id !== manifest.consent_record_id) throw Error('consent-invalid');
      const expected = manifest.files?.[file];
      if (!expected || !validHash(expected.sha256)) throw Error('fixture-not-allowed');
      const wav = await read(resolve(folder, file));
      const sha256 = hash(wav);
      if (wav.length < 44 || sha256 !== expected.sha256 || wav.toString('ascii', 0, 4) !== 'RIFF'
          || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length) throw Error('wav-invalid');
      let fmt, pcm, at = 12;
      while (at + 8 <= wav.length) {
        const id = wav.toString('ascii', at, at + 4), size = wav.readUInt32LE(at + 4), start = at + 8, end = start + size;
        if (end > wav.length) throw Error('wav-truncated');
        if (id === 'fmt ') { if (fmt) throw Error('fmt-duplicate'); fmt = wav.subarray(start, end); }
        if (id === 'data') { if (pcm) throw Error('data-duplicate'); pcm = wav.subarray(start, end); }
        at = end + size % 2;
      }
      if (at !== wav.length || !fmt || fmt.length < 16 || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1
          || fmt.readUInt32LE(4) !== 16000 || fmt.readUInt32LE(8) !== 32000 || fmt.readUInt16LE(12) !== 2
          || fmt.readUInt16LE(14) !== 16 || !pcm?.length || pcm.length % 2 || pcm.length / 2 !== expected.frames) throw Error('pcm-invalid');
      let nonzero = 0, peak = 0, firstSignalFrame = null;
      for (let i = 0; i < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i);
        if (sample) { nonzero++; firstSignalFrame ??= i / 2; }
        peak = Math.max(peak, Math.abs(sample));
      }
      if (nonzero !== expected.nonzero_frames || nonzero < 1600 || peak !== expected.peak_pcm16 || peak >= 32760) throw Error('signal-invalid');
      // The fixed rounds have 2 s of lead silence. A new case must retain at least
      // 100 ms to permit stream propagation before its first utterance.
      if (firstSignalFrame < 1600) throw Error('initial-silence-missing');
      const value = Object.freeze({base64: pcm.toString('base64'), sampleRate: 16000, frames: pcm.length / 2, sha256,
        nonzeroFrames: nonzero, firstSignalFrame, caseId, file, consentRecordId: consent.consent_record_id,
        registrySha256, manifestSha256: registry.cases[caseId]});
      validated.add(value);
      return value;
    },
  });
}
