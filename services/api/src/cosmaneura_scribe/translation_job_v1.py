from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from .canonical_json import canonical_sha256
from .external_transcript_v1 import TranslationOutcome
from .transcript_constraints import MAX_TRANSCRIPT_CONTENT_CHARS
from .translation_attempt_persistence import TranslationAttemptCommand

CompletedTranslationJobSchemaVersion = Literal["1.0"]
TranslationFailureCode = Annotated[
    str,
    Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$"),
]
TranslationProfileIdentifier = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    ),
]


class CompletedTranslationJobV1(BaseModel):
    """Protected durable boundary between one provider call and database commit."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )

    schema_version: CompletedTranslationJobSchemaVersion
    tenant_id: UUID = Field(repr=False)
    session_id: UUID = Field(repr=False)
    translation_id: UUID = Field(repr=False)
    expected_source_transcript_version: int = Field(ge=1, repr=False)
    source_segment_id: UUID = Field(repr=False)
    expected_source_segment_version: int = Field(ge=1, repr=False)
    expected_previous_translation_version: int = Field(ge=0, repr=False)
    source_locale: Literal["es-US"]
    target_locale: Literal["en-US"]
    outcome: TranslationOutcome
    translation_adapter_id: TranslationProfileIdentifier
    translation_model_profile_id: TranslationProfileIdentifier
    content: str | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_TRANSCRIPT_CONTENT_CHARS,
        repr=False,
    )
    failure_code: TranslationFailureCode | None = None

    @field_validator("content")
    @classmethod
    def content_is_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("completed translation content is empty")
        return value

    @model_validator(mode="after")
    def outcome_matches_payload(self) -> CompletedTranslationJobV1:
        if self.outcome == TranslationOutcome.SUCCEEDED:
            if self.content is None or self.failure_code is not None:
                raise ValueError("completed translation success payload is invalid")
        elif self.content is not None or self.failure_code is None:
            raise ValueError("completed translation failure payload is invalid")
        return self

    @classmethod
    def from_command(
        cls,
        *,
        tenant_id: UUID,
        session_id: UUID,
        command: TranslationAttemptCommand,
    ) -> CompletedTranslationJobV1:
        return cls(
            schema_version="1.0",
            tenant_id=tenant_id,
            session_id=session_id,
            translation_id=command.translation_id,
            expected_source_transcript_version=(command.expected_source_transcript_version),
            source_segment_id=command.source_segment_id,
            expected_source_segment_version=command.expected_source_segment_version,
            expected_previous_translation_version=(command.expected_previous_translation_version),
            source_locale="es-US",
            target_locale="en-US",
            outcome=command.outcome,
            translation_adapter_id=command.translation_adapter_id,
            translation_model_profile_id=command.translation_model_profile_id,
            content=command.content,
            failure_code=command.failure_code,
        )

    def to_command(self) -> TranslationAttemptCommand:
        return TranslationAttemptCommand(
            translation_id=self.translation_id,
            expected_source_transcript_version=self.expected_source_transcript_version,
            source_segment_id=self.source_segment_id,
            expected_source_segment_version=self.expected_source_segment_version,
            expected_previous_translation_version=(self.expected_previous_translation_version),
            outcome=self.outcome,
            translation_adapter_id=self.translation_adapter_id,
            translation_model_profile_id=self.translation_model_profile_id,
            content=self.content,
            failure_code=self.failure_code,
        )

    def fingerprint(self) -> str:
        return canonical_sha256(
            {
                "contract": "completed-translation-job-v1",
                "job": self,
            }
        )

    def __repr__(self) -> str:
        return "CompletedTranslationJobV1(<protected>)"

    def __str__(self) -> str:
        return self.__repr__()
