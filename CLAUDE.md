# cosmaneura-scribe

Ambient clinical capture. This service ends at a clean diarized transcript; note styling and value
point extraction remain in the existing Cosmaneura engine.

## Commands

- Dev: `make dev`
- Test: `uv run pytest`
- Lint/types: `uv run ruff check . && uv run pyright`
- OpenAPI: `make openapi`
- Migrate: `uv run alembic upgrade head`

## Hard rules

- Never log transcript text, audio/blob URLs, object names, patient names, or DOBs. Use entity IDs.
- A valid consent record precedes every audio-processing path, including tests and internal tools.
- Every row and query is tenant-scoped. Tenant identity comes from verified request context, never a body.
- Every mutating endpoint requires an `Idempotency-Key` and writes a metadata-only audit event.
- Every schema change includes an Alembic upgrade and a reviewed, rung-specific recovery path.
  Additive expand recovery leaves the new structure dormant; removal belongs only in a separately
  approved contract-cleanup change.
- Generate `openapi/openapi.json` from FastAPI. Never hand-edit it.

## Definition of done

Tests, lint, and types pass; OpenAPI is regenerated; migration recovery is defined and tested for
the declared rung; no PHI appears in logs/errors; an ADR is added for architectural choices.
