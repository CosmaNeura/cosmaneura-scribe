"""Bounded native restart evidence; never an assertion about missing speech."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .capture_protocol_v1 import MAX_CHUNKS


class NativeIntervalStart(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    source_start_id: UUID
    first_sequence_number: int = Field(strict=True, ge=0, lt=MAX_CHUNKS)


class CaptureContinuity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    schema_version: Literal["1.0"] = "1.0"
    continuity: Literal["interrupted_or_unconfirmed"] = "interrupted_or_unconfirmed"
    missing_audio: Literal["unknown"] = "unknown"
    starts: tuple[NativeIntervalStart, ...] = Field(min_length=2, max_length=1000)

    @model_validator(mode="after")
    def ordered_starts(self) -> "CaptureContinuity":
        positions = [item.first_sequence_number for item in self.starts]
        if (
            positions[0] != 0
            or positions != sorted(positions)
            or len({item.source_start_id for item in self.starts}) != len(self.starts)
        ):
            raise ValueError("capture_continuity_invalid")
        return self
