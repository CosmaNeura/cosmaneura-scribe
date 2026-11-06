# cosmaneura-scribe

Ambient clinical capture. Ends at a clean diarized transcript; note styling stays
in the Cosmaneura engine.

**Agent contract:** `AGENTS.md` (staging default; John’s yes for production;
synthetic data only). Prior long copy:
`docs/reference/archive/agent-rules/CLAUDE-pre-2026-11-05.md`.

## Commands

- Dev: `make dev` · Test: `uv run pytest` · Lint: `uv run ruff check . && uv run pyright`
- OpenAPI: `make openapi` · Migrate: `uv run alembic upgrade head`

## Domain hard rules

- Never log transcript text, audio/blob URLs, object names, patient names, or DOBs. Use entity IDs.
- A valid consent record precedes every audio-processing path, including tests.
- Every row and query is tenant-scoped from verified request context, never a body.
- Every mutating endpoint requires an `Idempotency-Key` and a metadata-only audit event.
- Every schema change includes Alembic upgrade and a reviewed, rung-specific recovery path.
- Generate `openapi/openapi.json` from FastAPI. Never hand-edit it.
