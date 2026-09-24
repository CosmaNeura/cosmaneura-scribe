"""Opt-in browser wire receiver: real encrypted audio, entirely offline providers."""

import asyncio
import base64
import json
import os
import socket
import wave
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import uvicorn
from alembic.config import Config
from cosmaneura_scribe.audio_assembly import (
    EncryptedBlobAudioTrackAssembler,
    RepositoryAudioAssemblyManifestProvider,
)
from cosmaneura_scribe.captured_admission_routes import (
    CapturedAdmissionRequestV1,
    CapturedAdmissionRuntime,
)
from cosmaneura_scribe.creator_review_routes import CreatorReviewRuntime
from cosmaneura_scribe.main import app, get_audio_encryption_key_provider
from cosmaneura_scribe.schemas import AudioEncryptionPublicKey, CaptureChannel, RsaPublicJwk
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import Request, Response
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from test_capture_protocol_api import CaptureKeyProvider, _base64url
from test_captured_admission_routes import trial as trial
from test_captured_processing import flow as flow
from test_captured_source_runtime import _result
from test_captured_transcription_worker import ReadingSpeech
from test_captured_transcription_worker import capture as capture

from alembic import command

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio, pytest.mark.skipif(
    not os.getenv("SCRIBE_PROVIDER_WIRE"), reason="explicit local provider rehearsal required"
)]


@pytest.fixture(scope="session")
def postgres_urls():
    """One owned DB and one unique non-bypass role; never reset another fixture's role."""
    raw = os.environ["COSMANEURA_SCRIBE_TEST_DATABASE_URL"]
    url = make_url(raw)
    socket_prefix = "/private/tmp/scribe-configured-core.provider."
    assert (url.username == "scribe_configured_owner" and url.host is None
            and url.query.get("host", "").startswith(socket_prefix)
            and url.query.get("port") == "55458"
            and (url.database or "").startswith("scribe_provider_browser_")
            and (url.database or "").endswith("_test"))
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", raw)
    command.upgrade(config, "head")
    role = "scribe_provider_wire_" + uuid4().hex[:16]

    async def create_role():
        engine = create_async_engine(raw, connect_args={"ssl": False})
        try:
            async with engine.begin() as connection:
                database = connection.dialect.identifier_preparer.quote(url.database)
                await connection.execute(text(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS"))
                await connection.execute(text(f"GRANT CONNECT ON DATABASE {database} TO {role}"))
                await connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
                await connection.execute(text(
                    f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {role}"
                ))
        finally:
            await engine.dispose()

    asyncio.run(create_role())
    # Preserve the isolated database, schema and role with the stopped owned cluster.
    yield raw, url.set(username=role).render_as_string(hide_password=False)


async def test_provider_workspace_receiver(flow):
    path = Path(os.environ["SCRIBE_CONFIGURED_WIRE_SCOPE"])
    assert str(path).startswith("/private/tmp/scribe-configured-core.provider.")
    trial = flow.capture.trial
    private = rsa.generate_private_key(public_exponent=65537, key_size=3072)

    class Key(CaptureKeyProvider):
        async def get_public_key(self):
            public = private.public_key().public_numbers()
            return AudioEncryptionPublicKey(
                key_version="capture-key-version",
                public_jwk=RsaPublicJwk(n=_base64url(public.n.to_bytes(384, "big")), e="AQAB"),
            )

    class Unwrapper:
        async def unwrap(self, audio_key):
            wrapped = base64.urlsafe_b64decode(
                audio_key.wrapped_dek + "=" * (-len(audio_key.wrapped_dek) % 4)
            )
            return bytearray(private.decrypt(wrapped, padding.OAEP(
                mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
            )))

        async def close(self):
            pass

    class Speech(ReadingSpeech):
        name = "azure_ai_speech"
        calls = 0

        async def transcribe(self, request):
            self.calls += 1
            assert request.language_code == "en-US+es-US" and len(request.tracks) == 1
            assert request.tracks[0].channel == CaptureChannel.MICROPHONE
            with request.tracks[0].open() as stream, wave.open(stream) as wav:
                assert wav.getframerate() == 16000 and wav.getnframes() == 48000
                assert wav.readframes(48000) == b"\x07\x00" * 48000
            result = _result()
            return replace(result, segments=tuple(
                replace(s, channel=CaptureChannel.MICROPHONE) for s in result.segments
            ))

        async def close(self):
            pass

    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=RepositoryAudioAssemblyManifestProvider(trial.provider),
        reader=flow.capture.reader,
        key_unwrapper=Unwrapper(), temporary_directory=flow.capture.temp,
    )
    flow.capture.assembler = assembler
    flow.capture.speech = Speech()
    flow.runtime = flow.fresh()
    app.dependency_overrides[get_audio_encryption_key_provider] = Key
    scope = dict(tenant_ids=frozenset({trial.tenant}), enabled=True)
    app.state.captured_admission_runtime = CapturedAdmissionRuntime(trial.provider, **scope)
    app.state.creator_review_runtime = CreatorReviewRuntime(trial.provider, **scope)
    original_routes = list(app.router.routes)

    @app.put("/__provider_blob/{object_id}")
    async def blob(object_id: UUID, request: Request):
        data = await request.body()
        assert 0 < len(data) < 2_000_000
        flow.capture.reader.objects[object_id] = data
        return Response(status_code=201)

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.01)
        assert server.started
        path.with_suffix(".ready").write_text(str(listener.getsockname()[1]))
        for _ in range(1800):
            if (path.with_suffix(".process").exists()
                    and not path.with_suffix(".processed").exists()):
                data = json.loads(path.with_suffix(".process").read_text())
                request = CapturedAdmissionRequestV1.model_validate(data["session_request"])
                trial.draft = request.draft(data["creator_actor_id"])
                await flow.runtime.process(**flow.scope)
                path.with_suffix(".processed").touch()
            if path.with_suffix(".done").exists():
                break
            await asyncio.sleep(0.1)
        else:
            pytest.fail("provider rehearsal timed out")
        assert flow.capture.speech.calls == 1 and len(flow.translator.calls) == 1
        assert await flow.counts() == (1, 1, 1)
        path.with_suffix(".evidence.json").write_text(json.dumps({
            "speech_calls": 1, "translation_calls": 1,
            "encrypted_chunks": len(flow.capture.reader.calls),
            "decrypted_frames": 48000, "all_providers_offline": True,
        }))
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, timeout=5)
        listener.close()
        await assembler.close()
        app.router.routes[:] = original_routes
        del app.state.captured_admission_runtime
        del app.state.creator_review_runtime
