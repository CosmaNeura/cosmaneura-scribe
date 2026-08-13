# syntax=docker/dockerfile:1

FROM ghcr.io/astral-sh/uv:0.11.32-python3.12-trixie-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
COPY services/api ./services/api

RUN uv sync --locked --no-editable

FROM python:3.12-slim-trixie AS runtime

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY --from=builder --chown=10001:10001 /app/.venv /app/.venv
COPY --chown=10001:10001 alembic.ini ./
COPY --chown=10001:10001 alembic ./alembic

USER 10001:10001

EXPOSE 8020

CMD ["uvicorn", "cosmaneura_scribe.main:app", "--host", "0.0.0.0", "--port", "8020", "--no-access-log"]
