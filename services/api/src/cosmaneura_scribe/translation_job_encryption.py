from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import TypeAdapter

from .audio_assembly import AudioAssemblyError, SessionKeyUnwrapper
from .audio_keys import AudioEncryptionKeyProvider, AudioEncryptionKeyUnavailable
from .canonical_json import canonical_json_bytes
from .schemas import SessionAudioKey
from .translation_execution_v1 import DurableTranslationJobRecordV1

MAX_JOB_BYTES = 1_048_576
_RECORD = TypeAdapter(DurableTranslationJobRecordV1)


class TranslationJobStoreError(RuntimeError):
    """Fixed local failure; never retain provider errors, SQL, content or keys."""


@dataclass(frozen=True, repr=False)
class EncryptedTranslationJob:
    key_version: str = field(repr=False)
    wrapped_dek: str = field(repr=False)
    nonce: bytes = field(repr=False)
    ciphertext: bytes = field(repr=False)

    def __repr__(self) -> str:
        return "EncryptedTranslationJob(<protected>)"


def job_metadata(record: DurableTranslationJobRecordV1, expires_at: datetime) -> dict[str, Any]:
    reservation = record.reservation
    return {
        "tenant_id": record.tenant_id,
        "session_id": record.session_id,
        "translation_id": reservation.translation_id,
        "source_transcript_version": reservation.expected_source_transcript_version,
        "source_segment_id": reservation.source_segment_id,
        "source_segment_version": reservation.expected_source_segment_version,
        "previous_translation_version": reservation.expected_previous_translation_version,
        "status": record.status.value,
        "reserved_at": record.reserved_at,
        "provider_call_started_at": record.provider_call_started_at,
        "provider_result_stored_at": record.provider_result_stored_at,
        "attempt_committed_at": record.attempt_committed_at,
        "expires_at": expires_at,
    }


def _aad(metadata: dict[str, Any], key_version: str, wrapped_dek: str) -> bytes:
    return canonical_json_bytes(
        {
            "contract": "scribe-encrypted-translation-job-v1",
            "metadata": metadata,
            "key_version": key_version,
            "wrapped_dek": wrapped_dek,
        }
    )


def _decode(value: str) -> bytes:
    return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)


class TranslationJobCipher:
    """Dormant envelope encryption, with existing server-owned key custody.

    Each write uses a new job-only AES key and nonce. The SessionAudioKey value is
    only the existing RSA unwrap transport; no recorder key or audio-key row is
    read/reused. The caller owns the injected providers' lifecycle.
    """

    def __init__(self, keys: AudioEncryptionKeyProvider, unwrapper: SessionKeyUnwrapper) -> None:
        self._keys = keys
        self._unwrapper = unwrapper

    async def seal(
        self, record: DurableTranslationJobRecordV1, *, expires_at: datetime
    ) -> EncryptedTranslationJob:
        key = bytearray(os.urandom(32))
        try:
            payload = _RECORD.dump_json(record, warnings="error")
            if len(payload) > MAX_JOB_BYTES:
                raise TranslationJobStoreError("translation_job_payload_invalid")
            published = await self._keys.get_public_key()
            public_key = rsa.RSAPublicNumbers(
                e=int.from_bytes(_decode(published.public_jwk.e)),
                n=int.from_bytes(_decode(published.public_jwk.n)),
            ).public_key()
            if public_key.key_size != 3072 or public_key.public_numbers().e != 65537:
                raise TranslationJobStoreError("translation_job_key_invalid")
            wrapped = public_key.encrypt(
                bytes(key),
                padding.OAEP(
                    mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
                ),
            )
            wrapped_dek = base64.urlsafe_b64encode(wrapped).rstrip(b"=").decode("ascii")
            nonce = os.urandom(12)
            ciphertext = AESGCM(bytes(key)).encrypt(
                nonce,
                payload,
                _aad(job_metadata(record, expires_at), published.key_version, wrapped_dek),
            )
            return EncryptedTranslationJob(published.key_version, wrapped_dek, nonce, ciphertext)
        except (AudioEncryptionKeyUnavailable, TypeError, ValueError):
            pass
        finally:
            key[:] = bytes(len(key))
        raise TranslationJobStoreError("translation_job_encryption_unavailable") from None

    async def open(
        self, envelope: EncryptedTranslationJob, *, metadata: dict[str, Any]
    ) -> DurableTranslationJobRecordV1:
        key: bytearray | None = None
        try:
            if len(envelope.nonce) != 12 or not 16 < len(envelope.ciphertext) <= MAX_JOB_BYTES + 16:
                raise TranslationJobStoreError("translation_job_ciphertext_invalid")
            key = await self._unwrapper.unwrap(
                SessionAudioKey(
                    session_id=metadata["session_id"],
                    created_at=metadata["reserved_at"],
                    key_version=envelope.key_version,
                    wrapped_dek=envelope.wrapped_dek,
                )
            )
            if len(key) != 32:
                raise TranslationJobStoreError("translation_job_key_invalid")
            payload = AESGCM(bytes(key)).decrypt(
                envelope.nonce,
                envelope.ciphertext,
                _aad(metadata, envelope.key_version, envelope.wrapped_dek),
            )
            record = _RECORD.validate_json(payload, strict=True)
            if job_metadata(record, metadata["expires_at"]) != metadata:
                raise TranslationJobStoreError("translation_job_scope_invalid")
            return record
        except (InvalidTag, AudioAssemblyError, KeyError, TypeError, ValueError):
            pass
        finally:
            if key is not None:
                key[:] = bytes(len(key))
        raise TranslationJobStoreError("translation_job_decryption_failed") from None

    def __repr__(self) -> str:
        return "TranslationJobCipher(<protected>)"


def job_scope(tenant_id: UUID, session_id: UUID, translation_id: UUID) -> dict[str, UUID]:
    if not all(
        isinstance(cast(object, value), UUID) for value in (tenant_id, session_id, translation_id)
    ):
        raise TranslationJobStoreError("translation_job_scope_invalid")
    return {"tenant_id": tenant_id, "session_id": session_id, "translation_id": translation_id}
