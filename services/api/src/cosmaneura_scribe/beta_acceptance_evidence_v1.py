from __future__ import annotations

from datetime import datetime
from enum import IntEnum, StrEnum
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

BetaAcceptanceSchemaVersion = Literal["1.0"]
SafeIdentifier = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    ),
]
GitCommitSha = Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]
Sha256Hex = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
ContainerImageDigest = Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")]
SigningTeamIdentifier = Annotated[str, Field(pattern=r"^[A-Z0-9]{10}$")]


class _StrictEvidenceModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class BetaArtifactComponent(StrEnum):
    SCRIBE_BACKEND = "scribe_backend"
    CORE_BACKEND = "core_backend"
    DATABASE = "database"
    ENVIRONMENT = "environment"
    DESKTOP = "desktop"
    IOS = "ios"
    TRANSLATION = "translation"


class BetaClientSurface(StrEnum):
    BACKEND = "backend"
    DESKTOP = "desktop"
    IOS = "ios"


class BetaScenarioId(StrEnum):
    EXISTING_MCD_IDENTITY = "existing_mcd_identity"
    OUTSIDE_MCD_IDENTITY = "outside_mcd_identity"
    CREATOR_ISOLATION = "creator_isolation"
    GOOGLE_MEET_CHROME = "google_meet_chrome"
    ZOOM_DESKTOP = "zoom_desktop"
    IOS_CAPTURE = "ios_capture"
    BILINGUAL_FLOW = "bilingual_flow"
    ENCOUNTER_BINDING = "encounter_binding"
    FAILURE_CONTROLS = "failure_controls"
    RETENTION_DELETION = "retention_deletion"


class BetaScenarioOutcome(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    BLOCKED = "blocked"


class BetaFindingSeverity(IntEnum):
    SEV1 = 1
    SEV2 = 2
    SEV3 = 3
    SEV4 = 4


class BetaFindingStatus(StrEnum):
    OPEN = "open"
    CLOSED = "closed"


class BetaFindingCategory(StrEnum):
    AUTH = "auth"
    CREATOR_ISOLATION = "creator_isolation"
    CONSENT = "consent"
    DATA_LOSS = "data_loss"
    SILENT_RECORDING = "silent_recording"
    DUPLICATE_NOTE = "duplicate_note"
    PHI_BOUNDARY = "phi_boundary"
    OTHER = "other"


class FounderAcceptanceDecision(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class BetaTechnicalBlocker(StrEnum):
    RUN_NOT_COMPLETE = "run_not_complete"
    SCENARIO_MISSING = "scenario_missing"
    SCENARIO_NOT_PASSING = "scenario_not_passing"
    OPEN_HIGH_SEVERITY_FINDING = "open_high_severity_finding"
    OPEN_CRITICAL_CONTROL_FINDING = "open_critical_control_finding"


class DesktopBetaArtifactV1(_StrictEvidenceModel):
    package_version: SafeIdentifier
    package_sha256: Sha256Hex
    signing_identity_sha256: Sha256Hex
    notarization_status: Literal["accepted"]
    macos_test_version: SafeIdentifier

    def __repr__(self) -> str:
        return "DesktopBetaArtifactV1(<protected>)"

    def __str__(self) -> str:
        return self.__repr__()


class IOSBetaArtifactV1(_StrictEvidenceModel):
    bundle_identifier: SafeIdentifier
    marketing_version: SafeIdentifier
    build_version: SafeIdentifier
    archive_sha256: Sha256Hex
    signing_team_id: SigningTeamIdentifier = Field(repr=False)
    testflight_build_id: SafeIdentifier = Field(repr=False)
    distribution_status: Literal["ready_to_test"]
    ios_test_version: SafeIdentifier

    def __repr__(self) -> str:
        return "IOSBetaArtifactV1(<protected>)"

    def __str__(self) -> str:
        return self.__repr__()


class TranslationBetaArtifactV1(_StrictEvidenceModel):
    adapter_id: SafeIdentifier
    model_profile_id: SafeIdentifier
    completed_job_schema_version: Literal["1.0"]
    completed_command_fingerprint: Sha256Hex = Field(repr=False)

    def __repr__(self) -> str:
        return "TranslationBetaArtifactV1(<protected>)"

    def __str__(self) -> str:
        return self.__repr__()


class BetaArtifactSetV1(_StrictEvidenceModel):
    schema_version: BetaAcceptanceSchemaVersion
    candidate_id: SafeIdentifier
    scribe_git_sha: GitCommitSha
    core_git_sha: GitCommitSha
    scribe_image_digest: ContainerImageDigest
    core_image_digest: ContainerImageDigest
    database_migration_head: SafeIdentifier
    bootstrap_policy_version: SafeIdentifier
    environment_id: SafeIdentifier
    environment_config_sha256: Sha256Hex
    synthetic_tenant_id: UUID = Field(repr=False)
    synthetic_practice_id: UUID = Field(repr=False)
    desktop: DesktopBetaArtifactV1 = Field(repr=False)
    ios: IOSBetaArtifactV1 = Field(repr=False)
    translation: TranslationBetaArtifactV1 = Field(repr=False)

    def component_fingerprint(self, component: BetaArtifactComponent) -> str:
        values: dict[BetaArtifactComponent, object] = {
            BetaArtifactComponent.SCRIBE_BACKEND: {
                "git_sha": self.scribe_git_sha,
                "image_digest": self.scribe_image_digest,
            },
            BetaArtifactComponent.CORE_BACKEND: {
                "git_sha": self.core_git_sha,
                "image_digest": self.core_image_digest,
            },
            BetaArtifactComponent.DATABASE: {
                "migration_head": self.database_migration_head,
                "bootstrap_policy_version": self.bootstrap_policy_version,
            },
            BetaArtifactComponent.ENVIRONMENT: {
                "environment_id": self.environment_id,
                "config_sha256": self.environment_config_sha256,
                "synthetic_tenant_id": self.synthetic_tenant_id,
                "synthetic_practice_id": self.synthetic_practice_id,
            },
            BetaArtifactComponent.DESKTOP: self.desktop,
            BetaArtifactComponent.IOS: self.ios,
            BetaArtifactComponent.TRANSLATION: self.translation,
        }
        return canonical_sha256(
            {
                "contract": "closed-beta-artifact-component-v1",
                "component": component,
                "value": values[component],
            }
        )

    def fingerprint(self) -> str:
        return canonical_sha256(
            {
                "contract": "closed-beta-artifact-set-v1",
                "artifact_set": self,
            }
        )

    def __repr__(self) -> str:
        return "BetaArtifactSetV1(<protected>)"

    def __str__(self) -> str:
        return self.__repr__()


class BetaArtifactBindingV1(_StrictEvidenceModel):
    component: BetaArtifactComponent
    fingerprint: Sha256Hex = Field(repr=False)

    def __repr__(self) -> str:
        return f"BetaArtifactBindingV1(component={self.component.value!r})"

    def __str__(self) -> str:
        return self.__repr__()


_REQUIRED_SCENARIO_SURFACES: dict[BetaScenarioId, frozenset[BetaClientSurface]] = {
    BetaScenarioId.EXISTING_MCD_IDENTITY: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP, BetaClientSurface.IOS}
    ),
    BetaScenarioId.OUTSIDE_MCD_IDENTITY: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP, BetaClientSurface.IOS}
    ),
    BetaScenarioId.CREATOR_ISOLATION: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP, BetaClientSurface.IOS}
    ),
    BetaScenarioId.GOOGLE_MEET_CHROME: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP}
    ),
    BetaScenarioId.ZOOM_DESKTOP: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP}
    ),
    BetaScenarioId.IOS_CAPTURE: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.IOS}
    ),
    BetaScenarioId.BILINGUAL_FLOW: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP, BetaClientSurface.IOS}
    ),
    BetaScenarioId.ENCOUNTER_BINDING: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP, BetaClientSurface.IOS}
    ),
    BetaScenarioId.FAILURE_CONTROLS: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP, BetaClientSurface.IOS}
    ),
    BetaScenarioId.RETENTION_DELETION: frozenset(
        {BetaClientSurface.BACKEND, BetaClientSurface.DESKTOP, BetaClientSurface.IOS}
    ),
}

_BASE_BACKEND_COMPONENTS = frozenset(
    {
        BetaArtifactComponent.SCRIBE_BACKEND,
        BetaArtifactComponent.CORE_BACKEND,
        BetaArtifactComponent.DATABASE,
        BetaArtifactComponent.ENVIRONMENT,
    }
)
_REQUIRED_SCENARIO_COMPONENTS: dict[
    BetaScenarioId, frozenset[BetaArtifactComponent]
] = {
    BetaScenarioId.EXISTING_MCD_IDENTITY: frozenset(
        {
            BetaArtifactComponent.CORE_BACKEND,
            BetaArtifactComponent.DATABASE,
            BetaArtifactComponent.ENVIRONMENT,
            BetaArtifactComponent.DESKTOP,
            BetaArtifactComponent.IOS,
        }
    ),
    BetaScenarioId.OUTSIDE_MCD_IDENTITY: frozenset(
        {
            BetaArtifactComponent.CORE_BACKEND,
            BetaArtifactComponent.DATABASE,
            BetaArtifactComponent.ENVIRONMENT,
            BetaArtifactComponent.DESKTOP,
            BetaArtifactComponent.IOS,
        }
    ),
    BetaScenarioId.CREATOR_ISOLATION: _BASE_BACKEND_COMPONENTS
    | {BetaArtifactComponent.DESKTOP, BetaArtifactComponent.IOS},
    BetaScenarioId.GOOGLE_MEET_CHROME: _BASE_BACKEND_COMPONENTS
    | {BetaArtifactComponent.DESKTOP},
    BetaScenarioId.ZOOM_DESKTOP: _BASE_BACKEND_COMPONENTS
    | {BetaArtifactComponent.DESKTOP},
    BetaScenarioId.IOS_CAPTURE: _BASE_BACKEND_COMPONENTS
    | {BetaArtifactComponent.IOS},
    BetaScenarioId.BILINGUAL_FLOW: _BASE_BACKEND_COMPONENTS
    | {
        BetaArtifactComponent.DESKTOP,
        BetaArtifactComponent.IOS,
        BetaArtifactComponent.TRANSLATION,
    },
    BetaScenarioId.ENCOUNTER_BINDING: frozenset(
        {
            BetaArtifactComponent.CORE_BACKEND,
            BetaArtifactComponent.DATABASE,
            BetaArtifactComponent.ENVIRONMENT,
            BetaArtifactComponent.DESKTOP,
            BetaArtifactComponent.IOS,
        }
    ),
    BetaScenarioId.FAILURE_CONTROLS: _BASE_BACKEND_COMPONENTS
    | {
        BetaArtifactComponent.DESKTOP,
        BetaArtifactComponent.IOS,
        BetaArtifactComponent.TRANSLATION,
    },
    BetaScenarioId.RETENTION_DELETION: _BASE_BACKEND_COMPONENTS
    | {
        BetaArtifactComponent.DESKTOP,
        BetaArtifactComponent.IOS,
        BetaArtifactComponent.TRANSLATION,
    },
}


def required_surfaces_for_scenario(
    scenario_id: BetaScenarioId,
) -> tuple[BetaClientSurface, ...]:
    return tuple(sorted(_REQUIRED_SCENARIO_SURFACES[scenario_id], key=lambda item: item.value))


def required_components_for_scenario(
    scenario_id: BetaScenarioId,
) -> tuple[BetaArtifactComponent, ...]:
    return tuple(sorted(_REQUIRED_SCENARIO_COMPONENTS[scenario_id], key=lambda item: item.value))


class BetaScenarioEvidenceV1(_StrictEvidenceModel):
    schema_version: BetaAcceptanceSchemaVersion
    scenario_id: BetaScenarioId
    surfaces: tuple[BetaClientSurface, ...] = Field(min_length=1, max_length=3)
    artifact_bindings: tuple[BetaArtifactBindingV1, ...] = Field(
        min_length=1,
        max_length=len(BetaArtifactComponent),
        repr=False,
    )
    started_at: datetime = Field(repr=False)
    ended_at: datetime = Field(repr=False)
    outcome: BetaScenarioOutcome
    failure_code: SafeIdentifier | None = None
    evidence_file_sha256: Sha256Hex = Field(repr=False)
    synthetic_only_confirmed: Literal[True]
    phi_present: Literal[False]

    @field_validator("surfaces")
    @classmethod
    def canonicalize_surfaces(
        cls,
        value: tuple[BetaClientSurface, ...],
    ) -> tuple[BetaClientSurface, ...]:
        if len(value) != len(set(value)):
            raise ValueError("beta acceptance surface is duplicated")
        return tuple(sorted(value, key=lambda item: item.value))

    @field_validator("artifact_bindings")
    @classmethod
    def canonicalize_bindings(
        cls,
        value: tuple[BetaArtifactBindingV1, ...],
    ) -> tuple[BetaArtifactBindingV1, ...]:
        components = [binding.component for binding in value]
        if len(components) != len(set(components)):
            raise ValueError("beta acceptance artifact binding is duplicated")
        return tuple(sorted(value, key=lambda item: item.component.value))

    @field_validator("started_at", "ended_at")
    @classmethod
    def evidence_times_have_offsets(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("beta acceptance timestamp requires an offset")
        return value

    @model_validator(mode="after")
    def validate_result(self) -> BetaScenarioEvidenceV1:
        if self.ended_at < self.started_at:
            raise ValueError("beta acceptance scenario time range is invalid")
        if self.outcome == BetaScenarioOutcome.PASSED:
            if self.failure_code is not None:
                raise ValueError("passing beta scenario cannot have a failure code")
        elif self.failure_code is None:
            raise ValueError("non-passing beta scenario requires a failure code")
        return self

    def __repr__(self) -> str:
        return (
            "BetaScenarioEvidenceV1("
            f"scenario_id={self.scenario_id.value!r}, outcome={self.outcome.value!r})"
        )

    def __str__(self) -> str:
        return self.__repr__()


def build_beta_scenario_evidence(
    *,
    artifacts: BetaArtifactSetV1,
    scenario_id: BetaScenarioId,
    started_at: datetime,
    ended_at: datetime,
    outcome: BetaScenarioOutcome,
    failure_code: str | None,
    evidence_file_sha256: str,
) -> BetaScenarioEvidenceV1:
    return BetaScenarioEvidenceV1(
        schema_version="1.0",
        scenario_id=scenario_id,
        surfaces=required_surfaces_for_scenario(scenario_id),
        artifact_bindings=tuple(
            BetaArtifactBindingV1(
                component=component,
                fingerprint=artifacts.component_fingerprint(component),
            )
            for component in required_components_for_scenario(scenario_id)
        ),
        started_at=started_at,
        ended_at=ended_at,
        outcome=outcome,
        failure_code=failure_code,
        evidence_file_sha256=evidence_file_sha256,
        synthetic_only_confirmed=True,
        phi_present=False,
    )


class BetaFindingV1(_StrictEvidenceModel):
    schema_version: BetaAcceptanceSchemaVersion
    finding_id: UUID = Field(repr=False)
    finding_code: SafeIdentifier
    scenario_id: BetaScenarioId | None = None
    category: BetaFindingCategory
    severity: BetaFindingSeverity
    status: BetaFindingStatus
    detected_at: datetime = Field(repr=False)
    closed_at: datetime | None = Field(default=None, repr=False)

    @field_validator("detected_at", "closed_at")
    @classmethod
    def finding_times_have_offsets(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("beta finding timestamp requires an offset")
        return value

    @model_validator(mode="after")
    def validate_lifecycle(self) -> BetaFindingV1:
        if self.status == BetaFindingStatus.OPEN and self.closed_at is not None:
            raise ValueError("open beta finding cannot have a close time")
        if self.status == BetaFindingStatus.CLOSED:
            if self.closed_at is None or self.closed_at < self.detected_at:
                raise ValueError("closed beta finding time is invalid")
        return self

    def __repr__(self) -> str:
        return (
            "BetaFindingV1("
            f"category={self.category.value!r}, severity={int(self.severity)!r}, "
            f"status={self.status.value!r})"
        )

    def __str__(self) -> str:
        return self.__repr__()


class BetaAcceptanceRunV1(_StrictEvidenceModel):
    schema_version: BetaAcceptanceSchemaVersion
    run_id: UUID = Field(repr=False)
    artifacts: BetaArtifactSetV1 = Field(repr=False)
    started_at: datetime = Field(repr=False)
    ended_at: datetime | None = Field(default=None, repr=False)
    scenario_results: tuple[BetaScenarioEvidenceV1, ...] = Field(
        default=(),
        max_length=len(BetaScenarioId),
        repr=False,
    )
    findings: tuple[BetaFindingV1, ...] = Field(default=(), max_length=128, repr=False)
    founder_decision: FounderAcceptanceDecision
    founder_decided_at: datetime | None = Field(default=None, repr=False)

    @field_validator("started_at", "ended_at", "founder_decided_at")
    @classmethod
    def run_times_have_offsets(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("beta acceptance run timestamp requires an offset")
        return value

    @field_validator("scenario_results")
    @classmethod
    def canonicalize_scenario_results(
        cls,
        value: tuple[BetaScenarioEvidenceV1, ...],
    ) -> tuple[BetaScenarioEvidenceV1, ...]:
        scenario_ids = [result.scenario_id for result in value]
        if len(scenario_ids) != len(set(scenario_ids)):
            raise ValueError("beta acceptance scenario result is duplicated")
        return tuple(sorted(value, key=lambda item: item.scenario_id.value))

    @field_validator("findings")
    @classmethod
    def canonicalize_findings(
        cls,
        value: tuple[BetaFindingV1, ...],
    ) -> tuple[BetaFindingV1, ...]:
        finding_ids = [finding.finding_id for finding in value]
        if len(finding_ids) != len(set(finding_ids)):
            raise ValueError("beta acceptance finding is duplicated")
        return tuple(sorted(value, key=lambda item: item.finding_id.int))

    @model_validator(mode="after")
    def validate_run(self) -> BetaAcceptanceRunV1:
        if self.ended_at is not None and self.ended_at < self.started_at:
            raise ValueError("beta acceptance run time range is invalid")
        for result in self.scenario_results:
            if result.started_at < self.started_at or (
                self.ended_at is not None and result.ended_at > self.ended_at
            ):
                raise ValueError("beta acceptance scenario falls outside its run")
            expected_surfaces = frozenset(
                _REQUIRED_SCENARIO_SURFACES[result.scenario_id]
            )
            if frozenset(result.surfaces) != expected_surfaces:
                raise ValueError("beta acceptance scenario surfaces are incomplete")
            bindings = {
                binding.component: binding.fingerprint
                for binding in result.artifact_bindings
            }
            expected_components = _REQUIRED_SCENARIO_COMPONENTS[result.scenario_id]
            if set(bindings) != set(expected_components):
                raise ValueError("beta acceptance artifact bindings are incomplete")
            if any(
                bindings[component] != self.artifacts.component_fingerprint(component)
                for component in expected_components
            ):
                raise ValueError("beta acceptance artifact binding is stale")
        if self.founder_decision == FounderAcceptanceDecision.PENDING:
            if self.founder_decided_at is not None:
                raise ValueError("pending founder decision cannot have a decision time")
        else:
            if self.founder_decided_at is None or self.ended_at is None:
                raise ValueError("founder decision requires a completed run and decision time")
            if self.founder_decided_at < self.ended_at:
                raise ValueError("founder decision precedes completed evidence")
        if (
            self.founder_decision == FounderAcceptanceDecision.ACCEPTED
            and self.technical_blockers()
        ):
            raise ValueError("founder cannot accept incomplete beta evidence")
        return self

    def missing_scenarios(self) -> tuple[BetaScenarioId, ...]:
        present = {result.scenario_id for result in self.scenario_results}
        return tuple(sorted(set(BetaScenarioId) - present, key=lambda item: item.value))

    def nonpassing_scenarios(self) -> tuple[BetaScenarioId, ...]:
        return tuple(
            result.scenario_id
            for result in self.scenario_results
            if result.outcome != BetaScenarioOutcome.PASSED
        )

    def technical_blockers(self) -> tuple[BetaTechnicalBlocker, ...]:
        blockers: list[BetaTechnicalBlocker] = []
        if self.ended_at is None:
            blockers.append(BetaTechnicalBlocker.RUN_NOT_COMPLETE)
        if self.missing_scenarios():
            blockers.append(BetaTechnicalBlocker.SCENARIO_MISSING)
        if self.nonpassing_scenarios():
            blockers.append(BetaTechnicalBlocker.SCENARIO_NOT_PASSING)
        open_findings = tuple(
            finding
            for finding in self.findings
            if finding.status == BetaFindingStatus.OPEN
        )
        if any(finding.severity <= BetaFindingSeverity.SEV2 for finding in open_findings):
            blockers.append(BetaTechnicalBlocker.OPEN_HIGH_SEVERITY_FINDING)
        critical_categories = set(BetaFindingCategory) - {BetaFindingCategory.OTHER}
        if any(finding.category in critical_categories for finding in open_findings):
            blockers.append(BetaTechnicalBlocker.OPEN_CRITICAL_CONTROL_FINDING)
        return tuple(blockers)

    def technically_ready(self) -> bool:
        return not self.technical_blockers()

    def activation_authorized(self) -> bool:
        return self.founder_decision == FounderAcceptanceDecision.ACCEPTED

    def fingerprint(self) -> str:
        return canonical_sha256(
            {
                "contract": "closed-beta-acceptance-run-v1",
                "run": self,
            }
        )

    def __repr__(self) -> str:
        return (
            "BetaAcceptanceRunV1("
            f"result_count={len(self.scenario_results)}, "
            f"founder_decision={self.founder_decision.value!r})"
        )

    def __str__(self) -> str:
        return self.__repr__()
