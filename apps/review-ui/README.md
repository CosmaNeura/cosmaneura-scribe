# Scribe Beta review UI

## Captured bilingual review component

The separate reusable `creator-review` bundle renders persisted captured
transcripts, recording/transcription status, Spanish original versus proposed
English, explicit acceptance/rejection, quality blockers and English readiness.
Build it with `npm run build:creator-review --workspace @cosmaneura-scribe/review-ui`.
The original synthetic-ingest app below is unchanged.

The authenticated host imports `mountCreatorReview` and `HttpCreatorReviewApi`,
supplies its existing authorized BFF/native request transport, and disposes the
panel on logout or encounter/session changes. The component neither acquires nor
stores authentication tokens and never accepts a creator/tenant from a form.
The transport forwards the exact decision body and `Idempotency-Key`, disables
caching and redirects, and must not log protected response content.

The paired Scribe GET/POST receiver is
`/v1/captured-sessions/{session_id}/review`. Server bootstrap must explicitly bind
`CreatorReviewRuntime` to `app.state.creator_review_runtime` with enabled=true
and the allowed tenant IDs. Reuse the existing app-only platform authentication;
the platform must reauthorize the actual creator and set
`X-Scribe-Creator-Actor-ID` itself. A browser-supplied actor is not authorization.
No normal startup, environment, live endpoint or native client is activated by
this component. The actual shell/BFF integration and physical acceptance remain
next; this is not a replacement sign-in page or SOAP-note engine.

Unconfirmed decisions retain the same request/key in memory for explicit retry.
The panel clears protected content on an unavailable response. Reload/disposal
does not preserve a pending request journal; native durable recovery still needs
integration. English readiness is not note creation, signature or dashboard save.

This is the synthetic-only local product surface for creating and reviewing a
process-local Scribe ingest. It does not accept patient details, capture audio,
connect to Azure or Entra, or publish anything.

## Run it this afternoon

Use Python 3.12, Node 24, npm 11.5.2, and `uv`. From the repository root, install
the locked dependencies and start both loopback processes:

```bash
uv sync --all-groups
npm ci
make local-scribe-beta
```

Open `http://127.0.0.1:5174`. Create a synthetic ingest and select it from the
session list to review the persisted response. The local API stores sessions in
process memory; stopping the launcher intentionally clears them.

The launcher owns both child processes. Press `Ctrl-C` once to stop the UI and API.
If the default ports are occupied, choose two loopback ports before starting:

```bash
COSMANEURA_SCRIBE_BETA_API_PORT=8121 \
COSMANEURA_SCRIBE_BETA_UI_PORT=5274 \
make local-scribe-beta
```

You can invoke `bash scripts/run-local-scribe-beta.sh` directly instead of the
Make target.

The UI sends requests only when the launcher supplies its fixed synthetic
tenant fixture. Starting the UI alone leaves all API actions locked.

The launcher uses the explicit local app factory. The separately configurable
preview-host entrypoint remains behind `beta_preview_host_enabled=false`; this
workflow does not enable it, publish an artifact, or create remote state.

## Checks

Focused UI checks:

```bash
npm run test --workspace @cosmaneura-scribe/review-ui
npm run typecheck --workspace @cosmaneura-scribe/review-ui
npm run lint --workspace @cosmaneura-scribe/review-ui
npm run build --workspace @cosmaneura-scribe/review-ui
```
