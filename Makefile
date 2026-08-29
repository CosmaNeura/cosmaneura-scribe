.PHONY: dev test lint types openapi
.PHONY: local-scribe-beta

dev:
	uv run uvicorn cosmaneura_scribe.main:app --app-dir services/api/src --reload --port 8020

test:
	uv run pytest

lint:
	uv run ruff check .

types:
	uv run pyright

openapi:
	uv run python scripts/generate_openapi.py

local-scribe-beta:
	bash scripts/run-local-scribe-beta.sh
