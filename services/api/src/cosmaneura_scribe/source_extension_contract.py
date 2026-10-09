"""A short-lived renewal for the same live native owner, never a start permit."""

from __future__ import annotations

import hashlib
import json
from typing import Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, SecretStr, model_validator

from .capture_protocol_v1 import MAX_CHUNKS, MAX_RESERVATIONS_PER_BATCH
from .source_start_contract import SourceKind, SourceStartIntent


class SourceExtensionIntent(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    schema_version: Literal["1.0"] = "1.0"

    owner: SourceStartIntent
    previous_extension_id: UUID | None = None
    lease_receipt_id: UUID
    lease_generation: int = Field(strict=True, ge=2)
    capture_authorized_until: AwareDatetime
    reservation_batch_id: UUID
    first_sequence_number: int = Field(strict=True, ge=1, lt=MAX_CHUNKS)
    reservation_count: int = Field(strict=True, ge=1, le=MAX_RESERVATIONS_PER_BATCH)

    @model_validator(mode="after")
    def bounded_extension(self) -> Self:
        if (
            self.first_sequence_number + self.reservation_count > MAX_CHUNKS
            or self.lease_generation <= self.owner.lease_generation
            or self.capture_authorized_until <= self.owner.capture_authorized_until
        ):
            raise ValueError("native extension bounds invalid")
        return self

    def fingerprint(self, session_id: UUID, actor: str) -> str:
        data = self.model_dump(mode="json", exclude={"owner"})
        data["owner"] = self.owner.fingerprint(session_id, actor)
        return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


class SourceExtensionReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    schema_version: Literal["1.0"] = "1.0"

    extension_id: UUID
    source_start_id: UUID
    session_id: UUID
    attempt_id: UUID
    creator_actor_id: str
    consent_record_id: UUID
    source: SourceKind
    lease_id: UUID
    lease_receipt_id: UUID
    lease_generation: int = Field(strict=True, ge=2)
    previous_extension_id: UUID | None
    previous_capture_authorized_until: AwareDatetime
    capture_authorized_until: AwareDatetime
    reservation_batch_id: UUID
    first_sequence_number: int = Field(strict=True, ge=1, lt=MAX_CHUNKS)
    maximum_sequence_number: int = Field(strict=True, ge=1, lt=MAX_CHUNKS)
    issued_at: AwareDatetime
    expires_at: AwareDatetime
    capability_id: UUID


class SourceExtensionCapability(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    receipt: SourceExtensionReceipt
    secret: SecretStr = Field(repr=False)
