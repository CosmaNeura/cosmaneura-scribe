# ADR 0039: Azure GPT-4.1 Spanish-to-English adapter

Status: implemented for explicit qualification; not registered in runtime.

The owner requested real transcription/model/translation services on 2026-09-21.
Reuse the existing translation interface and Azure GPT-4.1 family. An admitted
profile binds the exact Azure v1 endpoint, deployment, model snapshot and prompt
version into the persisted profile identifier. The adapter requires a caller-
supplied endpoint guard and server-side Entra credential; clients receive neither.

Each call translates only one Spanish source segment. It carries no tenant,
patient, encounter or source identifier. Existing English content bypasses this
adapter in the working-transcript projector. The prompt preserves source meaning,
including embedded English, negation, numbers/units, uncertainty and corrections.
The fixed JSON response cannot authorize note readiness or creator review.

Reject non-200 responses, redirects, unexpected models, incomplete/refused/tool
results, duplicate JSON keys, oversized bodies and invalid result schemas. There
is one HTTP request, a total deadline, no automatic retries and bounded failure
codes. Cancellation remains cancellation for the durable execution fence.

The existing worker contract remains responsible for storing reservation/result,
recovering ambiguous outcomes and checking current consent/tenant authority. This
adapter alone does not activate a service, relax private-network rules, create a
job store or complete clinical acceptance.

Official [Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs)
was checked on 2026-09-21. It requires closed schemas and refusal/incomplete-output
handling, and explicitly notes that structured output can still contain mistakes.
Therefore schema checks and source-fidelity evaluation are distinct evidence.

The accompanying Azure Speech bridge retains the actual phrase locale and maps
the manually selected English/Spanish mode to the two Azure candidate locales.
It never infers locale from speaker/channel or recognition confidence. Missing
and unsupported locales remain unknown; roles remain unknown until reviewed.
The opt-in normalized-source bridge is not registered with a route or worker.
The legacy raw transcript store does not retain phrase locales and is not the
bilingual handoff. Wiring the versioned receiver with admitted provider/model
profiles remains a separate integration requirement.
