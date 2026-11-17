"""Run a local-only synthetic ingest preview.

Start the app with::

    uv run uvicorn cosmaneura_scribe.local_ingest_preview:app \
      --app-dir services/api/src --port 8001

Then retrieve the process-local fixture with::

    curl -H 'X-Tenant-ID: 10000000-0000-4000-8000-000000000001' \
      http://127.0.0.1:8001/local/ingest-preview/20000000-0000-4000-8000-000000000001
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Response, status

from .synthetic_ingest import (
    SyntheticIngestSession,
    SyntheticIngestStore,
    get_synthetic_ingest,
    persist_synthetic_ingest,
    synthetic_ingest_store,
)

LOCAL_FIXTURE_TENANT_ID = UUID("10000000-0000-4000-8000-000000000001")
LOCAL_FIXTURE_SESSION_ID = UUID("20000000-0000-4000-8000-000000000001")
LOCAL_FIXTURE_STATUS = "transcript_ready"
LOCAL_FIXTURE_TRANSCRIPT = "Synthetic local transcript fixture."
_NOT_FOUND_DETAIL = "Synthetic ingest session not found."


def create_synthetic_ingest(
    store: SyntheticIngestStore = synthetic_ingest_store,
) -> SyntheticIngestSession:
    """Create the single non-PHI fixture served by the local preview app."""

    return persist_synthetic_ingest(
        tenant_id=LOCAL_FIXTURE_TENANT_ID,
        session_id=LOCAL_FIXTURE_SESSION_ID,
        status=LOCAL_FIXTURE_STATUS,
        transcript_text=LOCAL_FIXTURE_TRANSCRIPT,
        store=store,
    )


def _require_fixture_tenant_id(
    tenant_header: Annotated[str | None, Header(alias="X-Tenant-ID")] = None,
) -> UUID:
    try:
        tenant_id = UUID(tenant_header) if tenant_header is not None else None
    except ValueError:
        tenant_id = None
    if tenant_id is None or tenant_id != LOCAL_FIXTURE_TENANT_ID:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND_DETAIL)
    return LOCAL_FIXTURE_TENANT_ID


FixtureTenantId = Annotated[UUID, Depends(_require_fixture_tenant_id)]


def build_local_ingest_preview_app(
    store: SyntheticIngestStore = synthetic_ingest_store,
) -> FastAPI:
    """Build an isolated app that seeds its fixed fixture when the server starts."""

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        create_synthetic_ingest(store)
        yield

    preview_app = FastAPI(
        title="Cosmaneura Scribe Local Ingest Preview",
        description="Local-only, process-local synthetic ingest preview.",
        version="0.1.0",
        lifespan=lifespan,
    )

    def get_local_ingest_preview(
        session_id: str,
        response: Response,
        tenant_id: FixtureTenantId,
    ) -> SyntheticIngestSession:
        try:
            requested_session_id = UUID(session_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=_NOT_FOUND_DETAIL,
            ) from None
        session = get_synthetic_ingest(
            tenant_id=tenant_id,
            session_id=requested_session_id,
            store=store,
        )
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=_NOT_FOUND_DETAIL,
            )
        response.headers["Cache-Control"] = "no-store"
        return session

    preview_app.add_api_route(
        "/local/ingest-preview/{session_id}",
        get_local_ingest_preview,
        methods=["GET"],
        response_model=SyntheticIngestSession,
        response_model_exclude_none=True,
    )
    return preview_app


app = build_local_ingest_preview_app()
