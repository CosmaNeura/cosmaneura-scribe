"""Workload-only renewal for one live native recorder."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from .creator_review_routes import Creator, Key, Tenant
from .source_extension_contract import SourceExtensionIntent
from .source_extension_runtime import SourceExtensionRuntime
from .source_start_routes import HEADERS, NativeStartRoute
from .source_start_runtime import SourceStartConflict, SourceStartUnavailable


def get_source_extension_runtime(request: Request) -> SourceExtensionRuntime:
    runtime = getattr(request.app.state, "source_extension_runtime", None)
    if not isinstance(runtime, SourceExtensionRuntime):
        raise HTTPException(404, "source_extension_unavailable", headers=HEADERS)
    return runtime


router = APIRouter(
    prefix="/v1/captured-sessions", tags=["native-source-extension"], route_class=NativeStartRoute
)


@router.post("/{session_id}/source-extension", response_class=JSONResponse)
async def source_extension(
    session_id: UUID,
    payload: SourceExtensionIntent,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Annotated[SourceExtensionRuntime, Depends(get_source_extension_runtime)],
) -> JSONResponse:
    try:
        result = await runtime.extend(tenant_id, session_id, actor, key, payload)
    except SourceStartConflict:
        raise HTTPException(409, "source_extension_conflict", headers=HEADERS) from None
    except SourceStartUnavailable:
        raise HTTPException(404, "source_extension_unavailable", headers=HEADERS) from None
    return JSONResponse(
        {
            "receipt": result.receipt.model_dump(mode="json"),
            "secret": result.secret.get_secret_value(),
        },
        headers=HEADERS,
    )
