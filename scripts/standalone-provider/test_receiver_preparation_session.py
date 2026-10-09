"""Use the actual staging identity verifier and fictional owned PostgreSQL only."""

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe.provider_core_transport import CoreProviderMount, CoreProviderSelection
from cosmaneura_scribe.provider_preparation_handoff import PreparationHandoff, PreparedContext
from pydantic import SecretStr
from sqlalchemy import update
from sqlalchemy.orm import Session
from test_receiver import KEY, SUFFIX, OfflineKeys, jwt, receiver
from test_receiver import engine as engine
from test_receiver import harness as harness

# isort: split
# test_receiver verifies and installs the retained identity-source paths first.
from cosmas_os.api.auth import (  # noqa: E402
    CORE_STAGING_ISSUER,
    AccessDenied,
    AuthenticationFailed,
    ClerkTokenVerifier,
)
from cosmas_os.models import CoreProviderAccount  # noqa: E402


@pytest.mark.parametrize("origin", ["app://cosmas", "capacitor://localhost"])
def test_same_verified_clerk_session_refresh_reuses_context_but_keeps_fresh_identity(
    harness, engine, origin
):
    h = harness
    CoreProviderAccount.__table__.create(engine, checkfirst=True)
    with Session(engine) as db:
        db.add(
            CoreProviderAccount(
                id=h.account,
                box_id=h.box,
                principal_id=h.actor,
                issuer=CORE_STAGING_ISSUER,
                subject=h.subject,
                core_actor_ref="authority_actor_" + SUFFIX,
                core_tenant_ref="authority_tenant_" + SUFFIX,
                reviewed_by="invented fixture",
                evidence_ref="offline only",
                reviewed_at=datetime.now(UTC),
            )
        )
        db.commit()
    settings = receiver.Settings(
        _env_file=None,
        auth_mode="clerk_jwt",
        synth_seed=False,
        beta_box_id=h.box,
        clerk_issuer=CORE_STAGING_ISSUER,
        clerk_jwks_url=CORE_STAGING_ISSUER + "/.well-known/jwks.json",
        clerk_audience=None,
        clerk_organization_id=None,
        clerk_authorized_parties=origin,
        cors_allowed_origins=origin,
    )
    verifier = ClerkTokenVerifier(
        settings,
        jwks_client=OfflineKeys(),
        start_background_refresh=False,
        core_provider_session=True,
        allow_staging_desktop_session_without_origin=origin == "app://cosmas",
        allow_native_session_without_origin=origin == "capacitor://localhost",
    )
    profile = receiver.ReceiverProfile(
        "https://cosmaneura-staging-scribe-native.politesmoke-7989878f.northcentralus.azurecontainerapps.io",
        "https://staging-app.cosmaneura.com",
        uuid4(),
        frozenset({origin}),
        receiver.CORE_STAGING_PERSONAL,
    )
    instance = receiver.ProviderReceiver(
        profile, engine, settings, verifier, h.receiver.workload_token, enabled=True
    )

    async def check():
        now = datetime.now(UTC) - timedelta(seconds=3)

        def signed(at, sid="sess_invented"):
            return jwt.encode(
                {
                    "iss": CORE_STAGING_ISSUER,
                    "sub": h.subject,
                    "sid": sid,
                    "iat": at,
                    "nbf": at,
                    "exp": at + timedelta(minutes=3),
                },
                KEY,
                algorithm="RS256",
                headers={"kid": "offline-provider"},
            )

        first, refreshed = signed(now), signed(now + timedelta(seconds=1))
        assert first != refreshed
        a = instance.encounter_account("Bearer " + first, bind=engine)
        b = instance.encounter_account("Bearer " + refreshed, bind=engine)
        assert replace(a, user_token=b.user_token) == b
        selection = CoreProviderSelection(
            a.recovery_scope,
            uuid4(),
            UUID(h.workspace),
            "appointment_" + SUFFIX,
            a.actor_ref,
            a.tenant_ref,
        )
        pending = PreparationHandoff(clock=lambda: 100.0)
        context = PreparedContext(
            CoreProviderMount(selection, "scribe_capture_binding_" + SUFFIX),
            SecretStr("invented-context-token"),
            "invented-interaction-123",
            uuid4(),
            100.0,
            "admission",
        )
        pending.retain(
            profile.core_origin,
            a,
            UUID(h.revision),
            h.workspace,
            context.mount.binding_ref,
            context,
        )
        assert a.session_fingerprint == b.session_fingerprint and a.session_fingerprint is not None
        assert (
            pending.take(
                profile.core_origin,
                b,
                UUID(h.revision),
                h.workspace,
                context.mount.binding_ref,
                "admission",
            )
            == context
        )
        assert not pending._pending
        other = instance.encounter_account("Bearer " + signed(now, "sess_other"), bind=engine)
        assert other.session_fingerprint != a.session_fingerprint
        with pytest.raises(AuthenticationFailed):
            instance.encounter_account("Bearer " + signed(now - timedelta(minutes=5)), bind=engine)
        with pytest.raises(AuthenticationFailed):
            instance.encounter_account("Bearer " + signed(now, "invalid-session"), bind=engine)
        with Session(engine) as db:
            db.execute(
                update(CoreProviderAccount)
                .where(CoreProviderAccount.id == h.account)
                .values(revoked_at=datetime.now(UTC))
            )
            db.commit()
        with pytest.raises(AccessDenied):
            instance.encounter_account("Bearer " + refreshed, bind=engine)

    asyncio.run(check())
    verifier.close()
