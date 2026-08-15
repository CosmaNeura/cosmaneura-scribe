# De-identified speech-to-text benchmark

The benchmark measures provider word error rate, elapsed time, real-time factor, segment count, and
speaker count without emitting audio paths, reference text, recognized text, endpoints, tokens, or
patient identifiers. It uses the same passwordless Azure transcription adapter intended for the
worker, but it is not a production-processing path.

Only explicitly de-identified fixtures are allowed, and the consent gate still applies. Every case
must reference a valid consent record, assert that the record was verified before processing, and
identify whether its provenance is `synthetic` or `consented_deidentified`. Do not place patient
audio or reference transcripts in Git. Keep the manifest, audio, references, and output in an
approved encrypted local or Azure workspace. Case IDs must be opaque labels such as `sample-001`,
never names or encounter identifiers.

Example manifest:

```json
{
  "schema_version": "1.0",
  "deidentified": true,
  "cases": [
    {
      "case_id": "sample-001",
      "consent_record_id": "00000000-0000-4000-8000-000000000001",
      "consent_verified": true,
      "source_kind": "synthetic",
      "audio_path": "audio/sample-001.wav",
      "reference_path": "references/sample-001.txt",
      "language_code": "en-US",
      "channel": "mixed"
    }
  ]
}
```

Authenticate with Azure CLI locally, set the non-secret endpoint, and leave SDK wire logging off:

```bash
export AZURE_TOKEN_CREDENTIALS=dev
export COSMANEURA_SCRIBE_TRANSCRIPTION_BACKEND=azure
export COSMANEURA_SCRIBE_AZURE_SPEECH_ENDPOINT=https://<resource>.cognitiveservices.azure.com
uv run python scripts/benchmark_stt.py /secure/path/manifest.json \
  --output /secure/path/results.json
```

The calling identity needs only the applicable Cognitive Services Speech user role on the reviewed
Speech resource. Never use an API key for the production worker. A provider comparison is accepted
only after medical-term substitutions, speaker attribution, and low-confidence segments are
reviewed in the approved workspace; aggregate WER alone is insufficient.
