from __future__ import annotations

from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict

from .beta_ingest_store import (
    BetaIdempotencyConflictError,
    BetaIngest,
    BetaIngestStore,
)
from .safe_logging import configure_service_logging, log_event
from .settings import get_settings

LOCAL_BETA_TENANT_ID = UUID("00000000-0000-4000-8000-000000000029")
_API_PREFIX = "/api/beta"


class SyntheticIngestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    include_transcript: bool = True


class BetaIngestListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ingests: tuple[BetaIngest, ...]


IdempotencyKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=8, max_length=255, pattern=r"^\S(?:.*\S)?$"),
]


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncGenerator[None]:
    configure_service_logging()
    yield


def _store(request: Request) -> BetaIngestStore:
    store: object = request.app.state.beta_ingest_store
    if not isinstance(store, BetaIngestStore):
        raise RuntimeError("Beta ingest store is not configured")
    return store


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Synthetic session was not found.",
    )


def _require_local_tenant(
    tenant_header: Annotated[str | None, Header(alias="X-Tenant-ID")] = None,
) -> UUID:
    try:
        tenant_id = UUID(tenant_header) if tenant_header is not None else None
    except ValueError:
        tenant_id = None
    if tenant_id != LOCAL_BETA_TENANT_ID:
        raise _not_found()
    return LOCAL_BETA_TENANT_ID


TenantId = Annotated[UUID, Depends(_require_local_tenant)]


def create_beta_preview_app(
    *,
    enabled: bool = False,
    store: BetaIngestStore | None = None,
) -> FastAPI:
    """Build the isolated synthetic preview app; disabled means no routes are exposed."""

    preview_app = FastAPI(
        title="Cosmaneura Scribe Local Beta",
        version="0.1.0",
        description="Synthetic, process-local Scribe review preview.",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan,
    )
    preview_app.state.beta_ingest_store = store or BetaIngestStore()

    async def no_store_responses(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    preview_app.middleware("http")(no_store_responses)

    if not enabled:
        return preview_app

    def health() -> dict[str, str]:
        return {"status": "ok", "mode": "synthetic-local-beta"}

    def list_ingests(request: Request, tenant_id: TenantId) -> BetaIngestListResponse:
        return BetaIngestListResponse(ingests=_store(request).list_for_tenant(tenant_id=tenant_id))

    def create_ingest(
        payload: SyntheticIngestRequest,
        request: Request,
        response: Response,
        tenant_id: TenantId,
        idempotency_key: IdempotencyKey,
    ) -> BetaIngest:
        try:
            result = _store(request).create_synthetic(
                tenant_id=tenant_id,
                idempotency_key=idempotency_key,
                include_transcript=payload.include_transcript,
            )
        except BetaIdempotencyConflictError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Idempotency key was already used for a different request.",
            ) from None

        response.headers["Location"] = f"{_API_PREFIX}/ingests/{result.ingest.id}"
        if result.created:
            log_event(
                action="beta_preview.synthetic_ingest_created",
                tenant_id=tenant_id,
                entity_id=result.ingest.id,
            )
        else:
            response.status_code = status.HTTP_200_OK
        return result.ingest

    def get_ingest(request: Request, ingest_id: str, tenant_id: TenantId) -> BetaIngest:
        try:
            parsed_ingest_id = UUID(ingest_id)
        except ValueError:
            parsed_ingest_id = None
        ingest = (
            _store(request).get(tenant_id=tenant_id, ingest_id=parsed_ingest_id)
            if parsed_ingest_id is not None
            else None
        )
        if ingest is None:
            raise _not_found()
        return ingest

    preview_app.add_api_route("/healthz", health, methods=["GET"], include_in_schema=False)
    preview_app.add_api_route(
        f"{_API_PREFIX}/ingests",
        list_ingests,
        methods=["GET"],
        response_model=BetaIngestListResponse,
    )
    preview_app.add_api_route(
        f"{_API_PREFIX}/ingests",
        create_ingest,
        methods=["POST"],
        response_model=BetaIngest,
        status_code=status.HTTP_201_CREATED,
    )
    preview_app.add_api_route(
        f"{_API_PREFIX}/ingests/{{ingest_id}}",
        get_ingest,
        methods=["GET"],
        response_model=BetaIngest,
    )

    return preview_app


def create_local_beta_preview_app() -> FastAPI:
    """Explicit local-only entrypoint used by the founder launcher."""

    return create_beta_preview_app(enabled=True)


def create_configured_beta_preview_app() -> FastAPI:
    """Dark preview-host entrypoint; its settings latch is false by default."""

    return create_beta_preview_app(enabled=get_settings().beta_preview_host_enabled)


app = create_configured_beta_preview_app()
