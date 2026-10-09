"""Opt-in native fictional PCM through real modality/capture/worker boundaries.

Storage, key service, identity and recognition are explicit offline substitutes.
The API, consent policy, leases, envelopes, assembler and worker are real.
"""

from __future__ import annotations

import hashlib
import json
import os
import wave
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.audio_assembly import (
    EncryptedBlobAudioTrackAssembler,
    RepositoryAudioAssemblyManifestProvider,
)
from cosmaneura_scribe.schemas import AudioChunk, CaptureChannel, SessionStatus, SpeakerRole
from cosmaneura_scribe.transcription import SttResult, SttSegment, TranscriptionRequest
from cosmaneura_scribe.transcription_worker import AudioAssemblyRequest, TranscriptionWorker
from fastapi.testclient import TestClient
from test_audio_assembly import (
    WRAPPED_DEK,
    MemoryBlobReader,
    StaticKeyUnwrapper,
    _encrypt,
    _wave_bytes,
)
from test_capture_protocol_api import _headers
from test_capture_protocol_api import capture_client as capture_client

ROOT = os.environ.get("SCRIBE_SYNTHETIC_SPEECH_DIRECTORY")
NAMES = ("microphone-44100", "microphone-48000", "meeting-32000", "meeting-48000")
pytestmark = pytest.mark.skipif(not ROOT, reason="Opt-in native fictional PCM is required")


def _native_pcm(name: str) -> bytes:
    assert ROOT is not None
    consent_bytes = (Path(ROOT) / "synthetic-consent.json").read_bytes()
    consent = json.loads(consent_bytes)
    assert consent["schema"] == 1 and consent["generator"] == "macos-say-synthetic-v1"
    assert consent["synthetic_only"] is True and consent["all_parties_consented"] is True
    # Validate generator consent before reading any audio.
    receipt = json.loads((Path(ROOT) / f"{name}.json").read_text())
    assert receipt["schema"] == 1 and receipt["name"] == name
    assert receipt["synthetic_only"] is True and receipt["sample_rate_hz"] == 16_000
    assert receipt["consent_sha256"] == hashlib.sha256(consent_bytes).hexdigest()
    pcm = (Path(ROOT) / f"{name}.pcm").read_bytes()
    assert 32_000 < len(pcm) <= 30 * 32_000 and len(pcm) % 32_000 == 0
    assert receipt["frames"] == len(pcm) // 2
    assert receipt["pcm_sha256"] == hashlib.sha256(pcm).hexdigest()
    return pcm


class ReadingRecognitionSubstitute:
    """Checks actual decrypted input; returned words are invented, not recognized."""

    name = "virtual_input_verifier"

    def __init__(self, pcm: bytes, consent_id: UUID, session_id: UUID) -> None:
        self.pcm, self.consent_id, self.session_id = pcm, consent_id, session_id
        self.calls = 0

    async def transcribe(self, request: TranscriptionRequest) -> SttResult:
        self.calls += 1
        assert request.consent_record_id == self.consent_id
        assert request.session_id == self.session_id and request.language_code == "en-US"
        assert len(request.tracks) == 1 and request.tracks[0].channel == CaptureChannel.MIXED
        with request.tracks[0].open() as stream, wave.open(stream) as wav:
            assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16_000, 1, 2)
            received = wav.readframes(wav.getnframes())
        assert received == self.pcm
        return SttResult(
            provider=self.name,
            language_code=request.language_code,
            duration_ms=len(received) // 32,
            segments=tuple(
                SttSegment(
                    channel=CaptureChannel.MIXED,
                    provider_speaker_id=f"fictional-speaker-{i}",
                    start_ms=i * 1_000,
                    end_ms=(i + 1) * 1_000,
                    confidence=0.99,
                    content="Invented recognition substitute.",
                )
                for i in range(2)
            ),
        )

    async def close(self) -> None:
        pass


@pytest.mark.parametrize("modality", ["in_person", "phone", "virtual"])
@pytest.mark.parametrize("name", NAMES)
def test_native_audio_reaches_worker_intact_for_every_visit_modality(
    capture_client: TestClient,
    repository_backend: RepositoryBackend,
    tmp_path: Path,
    modality: str,
    name: str,
) -> None:
    pcm = _native_pcm(name)
    tenant = uuid4()
    identity = {
        "appointment_id": "virtual-modality-appointment",
        "practitioner_id": "virtual-modality-provider",
        "patient_id": "virtual-modality-patient",
        "modality": modality,
    }
    consent_body = {
        **identity,
        "participant_regions": ["US-NY"],
        "method": "verbal_attestation",
        "all_parties_consented": True,
        "granted_at": datetime.now(UTC).isoformat(),
    }
    consent = capture_client.post(
        "/v1/consents", headers=_headers(tenant, "virtual-consent"), json=consent_body
    )
    assert consent.status_code == 201 and consent.json()["modality"] == modality
    session_body = {**identity, "consent_record_id": consent.json()["id"]}
    mismatch = {**session_body, "modality": "phone" if modality != "phone" else "virtual"}
    assert (
        capture_client.post(
            "/v1/sessions", headers=_headers(tenant, "wrong-modality"), json=mismatch
        ).status_code
        == 409
    )
    session = capture_client.post(
        "/v1/sessions", headers=_headers(tenant, "virtual-session"), json=session_body
    )
    assert session.status_code == 201 and session.json()["modality"] == modality
    session_id = UUID(session.json()["id"])

    def post(suffix: str, body: dict, key: str):
        return capture_client.post(
            f"/v1/sessions/{session_id}/{suffix}", headers=_headers(tenant, key), json=body
        )

    key_response = post(
        "audio-key",
        {"key_version": "capture-key-version", "wrapped_dek": WRAPPED_DEK},
        "virtual-key",
    )
    assert key_response.status_code == 201
    lease = post("capture-lease", {"protocol_version": "1.0"}, "virtual-lease")
    assert lease.status_code == 201
    renewal = post(
        f"capture-leases/{lease.json()['lease_id']}/renew",
        {"protocol_version": "1.0", "expected_generation": lease.json()["generation"]},
        "virtual-renew",
    )
    assert renewal.status_code == 200
    current = renewal.json()
    slices = [pcm[i : i + 320_000] for i in range(0, len(pcm), 320_000)]
    reservation_body = {
        "protocol_version": "1.0",
        "capture_lease_id": current["lease_id"],
        "capture_lease_generation": current["generation"],
        "channel": "mixed",
        "first_sequence_number": 0,
        "count": len(slices),
    }
    reservation = post("chunk-reservations", reservation_body, "virtual-reserve")
    assert reservation.status_code == 201
    assert (
        post("chunk-reservations", reservation_body, "virtual-reserve").json() == reservation.json()
    )
    blobs = MemoryBlobReader({})
    audio_key = b"v" * 32
    for index, item in enumerate(reservation.json()["reservations"]):
        authorization = post(
            f"chunks/{item['object_id']}/upload-authorization",
            {"protocol_version": "1.0"},
            f"virtual-upload-{index}",
        )
        assert authorization.status_code == 201
        assert (
            authorization.json()["additional_authenticated_data"]
            == item["additional_authenticated_data"]
        )
        chunk = AudioChunk(
            id=uuid4(),
            session_id=session_id,
            sequence_number=index,
            channel=CaptureChannel.MIXED,
            object_id=UUID(item["object_id"]),
            sha256="0" * 64,
            ciphertext_size_bytes=1,
            registered_at=datetime.now(UTC),
        )
        request = AudioAssemblyRequest(tenant, session_id, (chunk,), uuid4(), uuid4())
        envelope = _encrypt(
            request, chunk, _wave_bytes(slices[index]), audio_key, (index + 1).to_bytes(12, "big")
        )
        blobs.objects[chunk.object_id] = envelope
        body = {
            "sequence_number": index,
            "channel": "mixed",
            "object_id": str(chunk.object_id),
            "sha256": hashlib.sha256(envelope).hexdigest(),
            "ciphertext_size_bytes": len(envelope),
        }
        registered = post("chunks", body, f"virtual-register-{index}")
        assert registered.status_code == 201
        assert post("chunks", body, f"virtual-register-{index}").json() == registered.json()
    completion = {
        "protocol_version": "1.0",
        "capture_lease_id": current["lease_id"],
        "capture_lease_generation": current["generation"],
        "channels": [{"channel": "mixed", "final_sequence_number": len(slices) - 1}],
    }
    result = post("capture-complete", completion, "virtual-complete")
    assert result.status_code == 200 and result.json()["status"] == "uploaded"
    assert post("capture-complete", completion, "virtual-complete").json() == result.json()
    transcriber = ReadingRecognitionSubstitute(pcm, UUID(consent.json()["id"]), session_id)
    assembler = EncryptedBlobAudioTrackAssembler(
        manifests=RepositoryAudioAssemblyManifestProvider(repository_backend.provider),
        reader=blobs,
        key_unwrapper=StaticKeyUnwrapper(audio_key),
        temporary_directory=tmp_path,
    )
    worker = TranscriptionWorker(
        repositories=repository_backend.provider, assembler=assembler, transcriber=transcriber
    )

    async def process():
        transcript = await worker.process(tenant_id=tenant, session_id=session_id)
        replay = await worker.process(tenant_id=tenant, session_id=session_id)
        assert replay == transcript and len(transcript.segments) == 2
        # A mixed track provides no trustworthy clinician/patient role prior.
        assert all(segment.speaker_role == SpeakerRole.UNKNOWN for segment in transcript.segments)
        assert len({segment.speaker_id for segment in transcript.segments}) == 2

    repository_backend.run(process)
    assert transcriber.calls == 1 and len(blobs.calls) == len(slices)
    final = repository_backend.session_for(tenant, session_id)
    assert final is not None and final.status == SessionStatus.TRANSCRIPT_READY
    assert final.modality.value == modality
    assert not list(tmp_path.iterdir())  # No decrypted audio remains on disk.
