"""Native-only workload route; explicit configuration and the paired Core release required."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from .creator_review_routes import Creator, Key, Tenant
from .source_start_contract import SourceStartCapability, SourceStartIntent, StartAction
from .source_start_runtime import SourceStartConflict, SourceStartRuntime, SourceStartUnavailable

HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


class NativeStartRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def protected(request: Request):
            try:
                return await handler(request)
            except RequestValidationError:
                # FastAPI's default validation response includes the input body;
                # hide malformed proof values as well as valid SecretStr values.
                return JSONResponse(
                    {"detail": "source_start_request_invalid"}, status_code=422, headers=HEADERS
                )

        return protected


def get_source_start_runtime(request: Request) -> SourceStartRuntime:
    value = getattr(request.app.state, "source_start_runtime", None)
    if not isinstance(value, SourceStartRuntime):
        raise HTTPException(404, "source_start_unavailable", headers=HEADERS)
    return value


Runtime = Annotated[SourceStartRuntime, Depends(get_source_start_runtime)]
router = APIRouter(
    prefix="/v1/captured-sessions", tags=["native-source-start"], route_class=NativeStartRoute
)


@router.post("/{session_id}/source-start/{action}", response_class=JSONResponse)
async def source_start(
    session_id: UUID,
    action: StartAction,
    payload: SourceStartIntent,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
):
    try:
        result = await runtime.act(tenant_id, session_id, actor, key, action, payload)
    except SourceStartConflict:
        raise HTTPException(409, "source_start_conflict", headers=HEADERS) from None
    except SourceStartUnavailable:
        raise HTTPException(404, "source_start_unavailable", headers=HEADERS) from None
    if isinstance(result, SourceStartCapability):
        return JSONResponse(
            {
                "receipt": result.receipt.model_dump(mode="json"),
                "secret": result.secret.get_secret_value(),
            },
            headers=HEADERS,
        )
    return JSONResponse(result.model_dump(mode="json"), headers=HEADERS)
