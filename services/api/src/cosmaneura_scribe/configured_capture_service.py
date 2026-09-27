"""Explicit, default-off API composition for the shared-Core capture release."""

from uuid import UUID

from fastapi import FastAPI

from .captured_admission_routes import CapturedAdmissionRuntime
from .captured_source_runtime import CapturedSourceRepositoryProvider
from .creator_review_routes import CreatorReviewRuntime
from .postgres_repository import PostgresRepositoryProvider
from .repository import RepositoryProvider
from .settings import Settings
from .source_extension_runtime import SourceExtensionRepositoryProvider, SourceExtensionRuntime
from .source_start_runtime import SourceStartRepositoryProvider, SourceStartRuntime


def bind_configured_capture_service(
    app: FastAPI, settings: Settings, provider: PostgresRepositoryProvider
) -> None:
    """Borrow the existing service engine; its lifespan remains the sole owner.

    No schema migration, identity lookup, worker or provider request is performed.
    All three routes share the same explicitly configured tenant cohort.
    """
    if not settings.configured_capture_enabled:
        return
    repositories = CapturedSourceRepositoryProvider(provider.engine)
    cohort = settings.configured_capture_tenant_ids
    app.state.captured_admission_runtime = CapturedAdmissionRuntime(
        repositories, tenant_ids=cohort, enabled=True
    )
    app.state.creator_review_runtime = CreatorReviewRuntime(
        repositories, tenant_ids=cohort, enabled=True
    )
    app.state.source_start_runtime = SourceStartRuntime(
        SourceStartRepositoryProvider(provider.engine), tenant_ids=cohort, enabled=True
    )

    if settings.configured_capture_continuation_enabled:
        app.state.source_extension_runtime = SourceExtensionRuntime(
            SourceExtensionRepositoryProvider(provider.engine), tenant_ids=cohort, enabled=True
        )


def unbind_configured_capture_service(app: FastAPI) -> None:
    for name in (
        "captured_admission_runtime",
        "creator_review_runtime",
        "source_start_runtime",
        "source_extension_runtime",
    ):
        if hasattr(app.state, name):
            delattr(app.state, name)


async def select_capture_protocol_provider(
    provider: RepositoryProvider, settings: Settings, tenant: UUID, session_id: UUID
) -> RepositoryProvider:
    """Select by persisted mode under tenant RLS, never by a client mode flag.

    Keep ordinary session/transcript APIs and non-cohort sessions on their
    existing provider. Only the existing capture-protocol endpoints call this.
    """
    if (
        not settings.configured_capture_enabled
        or tenant not in settings.configured_capture_tenant_ids
    ):
        return provider
    if not isinstance(provider, PostgresRepositoryProvider):
        raise RuntimeError("Configured capture requires its PostgreSQL provider.")
    captured = CapturedSourceRepositoryProvider(provider.engine)
    async with captured.transaction(tenant) as store:
        session = await store.get_session(tenant, session_id)
    return captured if session is not None else provider
