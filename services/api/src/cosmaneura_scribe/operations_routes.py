from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from .repository import RepositoryProvider

RepositoryProviderDependency = Callable[[], RepositoryProvider]


def build_operations_router(
    *,
    repository_provider_dependency: RepositoryProviderDependency,
) -> APIRouter:
    router = APIRouter(tags=["operations"])

    async def health() -> dict[str, str]:
        return {"status": "ok"}

    async def readiness(
        provider: Annotated[
            RepositoryProvider,
            Depends(repository_provider_dependency),
        ],
    ) -> dict[str, str]:
        try:
            await provider.health()
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail="Persistence is not ready.",
            ) from exc
        return {"status": "ready"}

    router.add_api_route("/healthz", health, methods=["GET"])
    router.add_api_route("/readyz", readiness, methods=["GET"])
    return router
