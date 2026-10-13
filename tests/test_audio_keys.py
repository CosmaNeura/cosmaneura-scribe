from __future__ import annotations

import asyncio
import base64
from datetime import UTC, datetime
from functools import lru_cache
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import pytest
from azure.core.credentials import AccessToken
from conftest import RepositoryBackend
from cosmaneura_scribe import main
from cosmaneura_scribe.audio_keys import (
    AudioEncryptionKeyUnavailable,
    BorrowedAudioEncryptionKeyProvider,
    KeyVaultAudioEncryptionKeyProvider,
)
from cosmaneura_scribe.main import app, get_audio_encryption_key_provider
from cosmaneura_scribe.schemas import (
    AudioChunk,
    AudioEncryptionPublicKey,
    CaptureChannel,
    RsaPublicJwk,
    SessionStatus,
)
from cosmaneura_scribe.settings import Settings
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


RSA_3072_MODULUS = _base64url(b"\x80" + b"m" * 383)
WRAPPED_DEK = _base64url(b"w" * 384)


class StaticCredential:
    def __init__(self) -> None:
        self.scopes: list[str] = []
        self.closed = False

    async def get_token(self, *scopes: str, **kwargs: object) -> AccessToken:
        del kwargs
        self.scopes.extend(scopes)
        return AccessToken("vault-token", 4_000_000_000)

    async def close(self) -> None:
        self.closed = True


class StaticKeyProvider:
    async def get_public_key(self) -> AudioEncryptionPublicKey:
        return AudioEncryptionPublicKey(
            key_version="version-1",
            public_jwk=RsaPublicJwk(n=RSA_3072_MODULUS, e="AQAB"),
        )

    def versioned_key_id(self, key_version: str) -> str | None:
        if key_version != "version-1":
            return None
        return f"https://scribe-test.vault.azure.net/keys/audio-encryption/{key_version}"

    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_key_provider_publishes_minimal_validated_rsa_3072_contract() -> None:
    credential = StaticCredential()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "attributes": {"enabled": True},
                "key": {
                    "kid": "https://scribe-test.vault.azure.net/keys/audio-encryption/version-1",
                    "kty": "RSA",
                    "key_ops": ["wrapKey", "unwrapKey"],
                    "n": RSA_3072_MODULUS,
                    "e": "AQAB",
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = KeyVaultAudioEncryptionKeyProvider(
            configured_key_id="https://scribe-test.vault.azure.net/keys/audio-encryption",
            credential=credential,
            client=client,
        )
        result = await provider.get_public_key()
        await provider.close()

    assert result.model_dump(mode="json") == {
        "key_version": "version-1",
        "algorithm": "RSA-OAEP-256",
        "public_jwk": {
            "kty": "RSA",
            "n": RSA_3072_MODULUS,
            "e": "AQAB",
            "alg": "RSA-OAEP-256",
            "ext": True,
            "key_ops": ["wrapKey"],
        },
    }
    assert credential.scopes == ["https://vault.azure.net/.default"]
    assert credential.closed
    assert seen[0].headers["authorization"] == "Bearer vault-token"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response_key",
    [
        {
            "kid": "https://different-test.vault.azure.net/keys/audio-encryption/version-1",
            "kty": "RSA",
            "key_ops": ["wrapKey", "unwrapKey"],
            "n": RSA_3072_MODULUS,
            "e": "AQAB",
        },
        {
            "kid": "https://scribe-test.vault.azure.net/keys/audio-encryption/version-1",
            "kty": "RSA",
            "key_ops": ["wrapKey"],
            "n": RSA_3072_MODULUS,
            "e": "AQAB",
        },
        {
            "kid": "https://scribe-test.vault.azure.net/keys/audio-encryption/version-1",
            "kty": "RSA",
            "key_ops": ["wrapKey", "unwrapKey"],
            "n": _base64url(b"m" * 256),
            "e": "AQAB",
        },
    ],
)
async def test_key_provider_rejects_unusable_key_material_without_echoing_it(
    response_key: dict[str, object],
) -> None:
    sensitive = "response-must-not-escape"
    response_key["detail"] = sensitive

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"attributes": {"enabled": True}, "key": response_key},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = KeyVaultAudioEncryptionKeyProvider(
            configured_key_id="https://scribe-test.vault.azure.net/keys/audio-encryption",
            credential=StaticCredential(),
            client=client,
        )
        with pytest.raises(AudioEncryptionKeyUnavailable) as caught:
            await provider.get_public_key()

    assert str(caught.value) == "audio_encryption_key_unavailable"
    assert sensitive not in repr(caught.value)


@pytest.mark.asyncio
async def test_key_provider_sanitizes_protocol_errors() -> None:
    sensitive = "protocol-detail-must-not-escape"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.RemoteProtocolError(sensitive, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = KeyVaultAudioEncryptionKeyProvider(
            configured_key_id="https://scribe-test.vault.azure.net/keys/audio-encryption",
            credential=StaticCredential(),
            client=client,
        )
        with pytest.raises(AudioEncryptionKeyUnavailable) as caught:
            await provider.get_public_key()

    assert str(caught.value) == "audio_encryption_key_unavailable"
    assert sensitive not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "attributes",
    [
        {"enabled": False},
        {"enabled": True, "nbf": 4_000_000_000},
        {"enabled": True, "exp": 1},
    ],
)
async def test_key_provider_rejects_disabled_or_inactive_versions(
    attributes: dict[str, object],
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "attributes": attributes,
                "key": {
                    "kid": ("https://scribe-test.vault.azure.net/keys/audio-encryption/version-1"),
                    "kty": "RSA",
                    "key_ops": ["wrapKey", "unwrapKey"],
                    "n": RSA_3072_MODULUS,
                    "e": "AQAB",
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = KeyVaultAudioEncryptionKeyProvider(
            configured_key_id=("https://scribe-test.vault.azure.net/keys/audio-encryption"),
            credential=StaticCredential(),
            client=client,
        )
        with pytest.raises(AudioEncryptionKeyUnavailable):
            await provider.get_public_key()


def test_key_provider_rejects_non_azure_key_vault_host_before_token_use() -> None:
    credential = StaticCredential()

    with pytest.raises(
        ValueError,
        match="versionless Azure Key Vault key ID",
    ):
        KeyVaultAudioEncryptionKeyProvider(
            configured_key_id="https://attacker.invalid/keys/audio-encryption",
            credential=credential,
        )

    assert credential.scopes == []


@pytest.mark.asyncio
async def test_borrowed_handles_reuse_transport_but_read_rotation_and_revocation() -> None:
    credential = StaticCredential()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "attributes": {"enabled": len(seen) < 3},
                "key": {
                    "kid": (
                        "https://scribe-test.vault.azure.net/keys/audio-encryption/"
                        f"version-{len(seen)}"
                    ),
                    "kty": "RSA",
                    "key_ops": ["wrapKey", "unwrapKey"],
                    "n": RSA_3072_MODULUS,
                    "e": "AQAB",
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        shared = KeyVaultAudioEncryptionKeyProvider(
            configured_key_id="https://scribe-test.vault.azure.net/keys/audio-encryption",
            credential=credential,
            client=client,
        )
        first, second = (BorrowedAudioEncryptionKeyProvider(shared) for _ in range(2))
        assert (await first.get_public_key()).key_version == "version-1"
        await first.close()
        with pytest.raises(AudioEncryptionKeyUnavailable):
            await first.get_public_key()
        assert first.versioned_key_id("version-1") is None
        assert not credential.closed and not client.is_closed
        assert (await second.get_public_key()).key_version == "version-2"
        with pytest.raises(AudioEncryptionKeyUnavailable):
            await second.get_public_key()
        await second.close()
        assert len(seen) == 3
        assert all(request.url.path == "/keys/audio-encryption" for request in seen)
        assert credential.scopes == ["https://vault.azure.net/.default"] * 3
        assert not credential.closed and not client.is_closed
        await shared.close()
        assert credential.closed


@pytest.mark.asyncio
async def test_closing_one_handle_during_io_does_not_close_another_request() -> None:
    entered, release = asyncio.Event(), asyncio.Event()

    class DelayedKeys(StaticKeyProvider):
        closed = False

        async def get_public_key(self) -> AudioEncryptionPublicKey:
            entered.set()
            await release.wait()
            assert not self.closed
            return await super().get_public_key()

        async def close(self) -> None:
            self.closed = True

    shared = DelayedKeys()
    first, second = (BorrowedAudioEncryptionKeyProvider(shared) for _ in range(2))
    pending = asyncio.create_task(first.get_public_key())
    await entered.wait()
    await first.close()
    release.set()
    with pytest.raises(AudioEncryptionKeyUnavailable):
        await pending
    assert (await second.get_public_key()).key_version == "version-1"
    await second.close()
    assert not shared.closed


@pytest.mark.asyncio
async def test_cancelled_key_read_does_not_poison_shared_provider() -> None:
    entered = asyncio.Event()

    class CancellableKeys(StaticKeyProvider):
        reads = 0
        closed = False

        async def get_public_key(self) -> AudioEncryptionPublicKey:
            self.reads += 1
            if self.reads == 1:
                entered.set()
                await asyncio.Event().wait()
            assert not self.closed
            return await super().get_public_key()

        async def close(self) -> None:
            self.closed = True

    shared = CancellableKeys()
    first = BorrowedAudioEncryptionKeyProvider(shared)
    pending = asyncio.create_task(first.get_public_key())
    await entered.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    await first.close()
    second = BorrowedAudioEncryptionKeyProvider(shared)
    assert (await second.get_public_key()).key_version == "version-1"
    await second.close()
    assert shared.reads == 2 and not shared.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("failed_shutdown", [False, True])
async def test_application_shutdown_closes_the_borrowed_provider_owner_once(
    monkeypatch, failed_shutdown
) -> None:
    class CountingCredential(StaticCredential):
        closes = 0

        async def close(self) -> None:
            self.closes += 1
            await super().close()

    credential = CountingCredential()
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(503)))
    with patch("cosmaneura_scribe.audio_keys.httpx.AsyncClient", return_value=client):
        shared = KeyVaultAudioEncryptionKeyProvider(
            configured_key_id="https://scribe-test.vault.azure.net/keys/audio-encryption",
            credential=credential,
        )

    @lru_cache
    def cached_keys():
        return shared

    monkeypatch.setattr(main, "get_settings", lambda: Settings(configured_capture_enabled=False))
    monkeypatch.setattr(main, "get_audio_encryption_key_provider", cached_keys)
    for name in ("get_repository_provider", "get_audio_storage", "get_master_platform_handoff"):
        monkeypatch.setattr(main, name, lru_cache(lambda: None))

    from cosmaneura_scribe.creator_preparation_routes import preparation_keys

    async def serve():
        async with main.lifespan(app):
            assert cached_keys.cache_info().currsize == 1
            for _ in range(2):
                handle = preparation_keys()
                with pytest.raises(AudioEncryptionKeyUnavailable):
                    await handle.get_public_key()
                await handle.close()
            assert not client.is_closed and credential.closes == 0
            if failed_shutdown:
                raise RuntimeError("Synthetic shutdown failure")

    if failed_shutdown:
        with pytest.raises(RuntimeError, match="Synthetic shutdown failure"):
            await serve()
    else:
        await serve()
    assert client.is_closed and credential.closes == 1
    assert cached_keys.cache_info().currsize == 0


def _headers(tenant_id: UUID, key: str) -> dict[str, str]:
    return {"X-Tenant-ID": str(tenant_id), "Idempotency-Key": key}


def _create_session(client: TestClient, tenant_id: UUID) -> dict[str, object]:
    identity = {
        "appointment_id": "appointment-audio-key",
        "practitioner_id": "practitioner-audio-key",
        "patient_id": "patient-audio-key",
        "modality": "virtual",
    }
    consent = client.post(
        "/v1/consents",
        headers=_headers(tenant_id, "audio-key-consent-0001"),
        json={
            **identity,
            "participant_regions": ["FL"],
            "method": "pre_visit_form",
            "all_parties_consented": True,
            "granted_at": datetime.now(UTC).isoformat(),
        },
    )
    assert consent.status_code == 201
    session = client.post(
        "/v1/sessions",
        headers=_headers(tenant_id, "audio-key-session-0001"),
        json={**identity, "consent_record_id": consent.json()["id"]},
    )
    assert session.status_code == 201
    return session.json()


def test_audio_key_endpoints_are_minimal_idempotent_and_immutable(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    app.dependency_overrides[get_audio_encryption_key_provider] = StaticKeyProvider
    tenant_id = uuid4()
    session = _create_session(client, tenant_id)
    session_id = UUID(str(session["id"]))

    public_key = client.get(
        "/v1/audio-encryption-key",
        headers={"X-Tenant-ID": str(tenant_id)},
    )
    body = {"key_version": "version-1", "wrapped_dek": WRAPPED_DEK}
    stale = client.post(
        f"/v1/sessions/{session_id}/audio-key",
        headers=_headers(tenant_id, "audio-key-bind-0001"),
        json={"key_version": "version-2", "wrapped_dek": WRAPPED_DEK},
    )
    first = client.post(
        f"/v1/sessions/{session_id}/audio-key",
        headers=_headers(tenant_id, "audio-key-bind-0001"),
        json=body,
    )
    replay = client.post(
        f"/v1/sessions/{session_id}/audio-key",
        headers=_headers(tenant_id, "audio-key-bind-0001"),
        json=body,
    )
    conflict = client.post(
        f"/v1/sessions/{session_id}/audio-key",
        headers=_headers(tenant_id, "audio-key-bind-0002"),
        json={"key_version": "version-1", "wrapped_dek": _base64url(b"x" * 384)},
    )

    assert public_key.status_code == 200
    assert stale.status_code == 409
    assert stale.json() == {"detail": "The audio encryption key version is no longer current."}
    assert set(public_key.json()) == {"key_version", "algorithm", "public_jwk"}
    assert first.status_code == 201
    assert replay.json() == first.json()
    assert set(first.json()) == {"session_id", "key_version", "created_at"}
    assert "wrapped" not in first.text
    assert "vault" not in first.text
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": "The session audio key is immutable."}

    grant_request = {"sequence_number": 0, "channel": "mixed"}
    grant = client.post(
        f"/v1/sessions/{session_id}/chunks/upload-grant",
        headers=_headers(tenant_id, "audio-key-grant-0001"),
        json=grant_request,
    )
    assert grant.status_code == 201
    chunk_request = {
        **grant_request,
        "object_id": grant.json()["object_id"],
        "sha256": "a" * 64,
        "ciphertext_size_bytes": 4_096,
    }
    chunk = client.post(
        f"/v1/sessions/{session_id}/chunks",
        headers=_headers(tenant_id, "audio-key-chunk-0001"),
        json=chunk_request,
    )
    assert chunk.status_code == 201
    complete = client.post(
        f"/v1/sessions/{session_id}/complete",
        headers=_headers(tenant_id, "audio-key-complete-0001"),
    )
    assert complete.status_code == 200
    transcript_request = {
        "language_code": "en-US",
        "stt_provider": "test_adapter",
        "segments": [
            {
                "speaker_id": "speaker-1",
                "speaker_role": "unknown",
                "content": "Synthetic replay fixture.",
                "start_ms": 0,
                "end_ms": 500,
            }
        ],
    }
    transcript = client.post(
        f"/v1/sessions/{session_id}/transcript",
        headers=_headers(tenant_id, "audio-key-transcript-0001"),
        json=transcript_request,
    )
    assert transcript.status_code == 201

    late_key_replay = client.post(
        f"/v1/sessions/{session_id}/audio-key",
        headers=_headers(tenant_id, "audio-key-bind-0001"),
        json=body,
    )
    late_grant_replay = client.post(
        f"/v1/sessions/{session_id}/chunks/upload-grant",
        headers=_headers(tenant_id, "audio-key-grant-0001"),
        json=grant_request,
    )
    late_chunk_replay = client.post(
        f"/v1/sessions/{session_id}/chunks",
        headers=_headers(tenant_id, "audio-key-chunk-0001"),
        json=chunk_request,
    )
    late_transcript_replay = client.post(
        f"/v1/sessions/{session_id}/transcript",
        headers=_headers(tenant_id, "audio-key-transcript-0001"),
        json=transcript_request,
    )

    assert late_key_replay.json() == first.json()
    assert late_grant_replay.json() == grant.json()
    assert late_chunk_replay.json() == chunk.json()
    assert late_transcript_replay.json() == transcript.json()

    async def read_persisted() -> tuple[str, str] | None:
        async with repository_backend.provider.transaction(tenant_id) as repository:
            persisted = await repository.get_session_audio_key(tenant_id, session_id)
            if persisted is None:
                return None
            return persisted.key_version, persisted.wrapped_dek

    assert repository_backend.run(read_persisted) == ("version-1", WRAPPED_DEK)
    actions = repository_backend.audit_actions(tenant_id)
    assert actions.count("session_audio_key.bound") == 1


def test_audio_key_binding_is_tenant_scoped(client: TestClient) -> None:
    app.dependency_overrides[get_audio_encryption_key_provider] = StaticKeyProvider
    owner_tenant = uuid4()
    session = _create_session(client, owner_tenant)

    response = client.post(
        f"/v1/sessions/{session['id']}/audio-key",
        headers=_headers(uuid4(), "audio-key-wrong-tenant-0001"),
        json={"key_version": "version-1", "wrapped_dek": WRAPPED_DEK},
    )

    assert response.status_code == 404


def test_upload_grant_requires_bound_session_audio_key(client: TestClient) -> None:
    app.dependency_overrides[get_audio_encryption_key_provider] = StaticKeyProvider
    tenant_id = uuid4()
    session = _create_session(client, tenant_id)

    response = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=_headers(tenant_id, "audio-key-missing-grant-0001"),
        json={"sequence_number": 0, "channel": "mixed"},
    )

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Register the session audio key before requesting upload grants."
    }

    bound = client.post(
        f"/v1/sessions/{session['id']}/audio-key",
        headers=_headers(tenant_id, "audio-key-missing-bind-0001"),
        json={"key_version": "version-1", "wrapped_dek": WRAPPED_DEK},
    )
    retry = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=_headers(tenant_id, "audio-key-missing-grant-0001"),
        json={"sequence_number": 0, "channel": "mixed"},
    )

    assert bound.status_code == 201
    assert retry.status_code == 201


def test_preexisting_keyless_capture_cannot_register_complete_or_bind_late(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    app.dependency_overrides[get_audio_encryption_key_provider] = StaticKeyProvider
    tenant_id = uuid4()
    session = _create_session(client, tenant_id)
    session_id = UUID(str(session["id"]))

    register = client.post(
        f"/v1/sessions/{session_id}/chunks",
        headers=_headers(tenant_id, "audio-key-missing-register-0001"),
        json={
            "sequence_number": 0,
            "channel": "mixed",
            "object_id": str(uuid4()),
            "sha256": "a" * 64,
            "ciphertext_size_bytes": 4_096,
        },
    )
    assert register.status_code == 409
    assert register.json() == {
        "detail": "Register the session audio key before registering audio chunks."
    }

    async def seed_preexisting_chunk() -> None:
        async with repository_backend.provider.transaction(tenant_id) as repository:
            persisted = await repository.get_session(tenant_id, session_id)
            assert persisted is not None
            await repository.add_chunk(
                tenant_id,
                AudioChunk(
                    id=uuid4(),
                    session_id=session_id,
                    sequence_number=0,
                    channel=CaptureChannel.MIXED,
                    object_id=uuid4(),
                    sha256="b" * 64,
                    ciphertext_size_bytes=4_096,
                    registered_at=datetime.now(UTC),
                ),
            )
            await repository.update_session(
                tenant_id,
                persisted.model_copy(update={"status": SessionStatus.CAPTURING}),
            )

    repository_backend.run(seed_preexisting_chunk)
    late_bind = client.post(
        f"/v1/sessions/{session_id}/audio-key",
        headers=_headers(tenant_id, "audio-key-late-bind-0001"),
        json={"key_version": "version-1", "wrapped_dek": WRAPPED_DEK},
    )
    complete = client.post(
        f"/v1/sessions/{session_id}/complete",
        headers=_headers(tenant_id, "audio-key-missing-complete-0001"),
    )

    assert late_bind.status_code == 409
    assert late_bind.json() == {"detail": "The session is not accepting an audio key."}
    assert complete.status_code == 409
    assert complete.json() == {
        "detail": "Register the session audio key before completing capture."
    }


@pytest.mark.postgres
def test_session_audio_key_migration_rejects_update_but_allows_retention_delete(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = uuid4()
    consent_id = uuid4()
    session_id = uuid4()

    async def scenario() -> None:
        engine = create_async_engine(app_url, connect_args={"ssl": False})
        try:
            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO consent_records (
                            id, tenant_id, appointment_id, practitioner_id, patient_id,
                            modality, participant_regions, method, all_parties_consented,
                            granted_at, policy_version
                        ) VALUES (
                            :consent_id, :tenant_id, 'appointment-audio-key-migration',
                            'practitioner-audio-key-migration', 'patient-audio-key-migration',
                            'virtual', ARRAY['FL'], 'pre_visit_form', true, now(), 'all-party-v1'
                        )
                        """
                    ),
                    {"consent_id": consent_id, "tenant_id": tenant_id},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO scribe_sessions (
                            id, tenant_id, appointment_id, practitioner_id, patient_id,
                            consent_record_id, modality, status
                        ) VALUES (
                            :session_id, :tenant_id, 'appointment-audio-key-migration',
                            'practitioner-audio-key-migration', 'patient-audio-key-migration',
                            :consent_id, 'virtual', 'created'
                        )
                        """
                    ),
                    {
                        "session_id": session_id,
                        "tenant_id": tenant_id,
                        "consent_id": consent_id,
                    },
                )

            for invalid_wrapped_dek in (WRAPPED_DEK[:-1], f"!{WRAPPED_DEK[1:]}"):
                with pytest.raises(DBAPIError, match="check constraint"):
                    async with engine.begin() as connection:
                        await connection.execute(
                            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                            {"tenant_id": str(tenant_id)},
                        )
                        await connection.execute(
                            text(
                                """
                                INSERT INTO session_audio_keys (
                                    tenant_id, session_id, key_version, wrapped_dek
                                ) VALUES (
                                    :tenant_id, :session_id, 'version-1', :wrapped_dek
                                )
                                """
                            ),
                            {
                                "tenant_id": tenant_id,
                                "session_id": session_id,
                                "wrapped_dek": invalid_wrapped_dek,
                            },
                        )

            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        INSERT INTO session_audio_keys (
                            tenant_id, session_id, key_version, wrapped_dek
                        ) VALUES (:tenant_id, :session_id, 'version-1', :wrapped_dek)
                        """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "session_id": session_id,
                        "wrapped_dek": WRAPPED_DEK,
                    },
                )

            with pytest.raises(DBAPIError, match="session audio keys are immutable"):
                async with engine.begin() as connection:
                    await connection.execute(
                        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                        {"tenant_id": str(tenant_id)},
                    )
                    await connection.execute(
                        text(
                            """
                            UPDATE session_audio_keys SET key_version = 'version-2'
                            WHERE tenant_id = :tenant_id AND session_id = :session_id
                            """
                        ),
                        {"tenant_id": tenant_id, "session_id": session_id},
                    )

            async with engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        """
                        DELETE FROM session_audio_keys
                        WHERE tenant_id = :tenant_id AND session_id = :session_id
                        """
                    ),
                    {"tenant_id": tenant_id, "session_id": session_id},
                )
                remaining = await connection.scalar(text("SELECT count(*) FROM session_audio_keys"))
                assert remaining == 0
        finally:
            await engine.dispose()

    asyncio.run(scenario())
