from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from math import inf, nan
from zoneinfo import ZoneInfo

import pytest
from cosmaneura_scribe.canonical_json import canonical_json_bytes, canonical_sha256
from cosmaneura_scribe.main import _fingerprint
from cosmaneura_scribe.schemas import ConsentCreate

PINNED_CONSENT_DIGEST = "46847c827002eae6aa143a9a91abe5d7594e015149a0bf38d9b432dc0788b07d"


def test_consent_fingerprint_is_canonical_and_pinned() -> None:
    payload = ConsentCreate(
        appointment_id="appointment-fixed",
        practitioner_id="practitioner-fixed",
        patient_id="patient-fixed",
        modality="virtual",
        participant_regions={"TX", "CA", "NY", "FL"},
        method="pre_visit_form",
        all_parties_consented=True,
        granted_at=datetime.fromisoformat("2026-08-15T12:34:56.123456-04:00"),
    )
    equivalent_utc = payload.model_copy(
        update={"granted_at": datetime(2026, 8, 15, 16, 34, 56, 123456, tzinfo=UTC)}
    )

    assert _fingerprint(payload) == PINNED_CONSENT_DIGEST
    assert _fingerprint(equivalent_utc) == PINNED_CONSENT_DIGEST
    assert payload.model_dump(mode="json")["participant_regions"] == ["CA", "FL", "NY", "TX"]


def test_canonical_json_rejects_naive_datetimes() -> None:
    with pytest.raises(ValueError, match="Canonical datetimes must include a UTC offset"):
        canonical_json_bytes(datetime(2026, 8, 15, 16, 34, 56, 123456))


def test_canonical_json_rejects_non_finite_numbers() -> None:
    for value in (nan, inf, -inf):
        with pytest.raises(ValueError, match="Canonical numbers must be finite"):
            canonical_json_bytes(value)


def test_canonical_json_rejects_non_string_mapping_keys() -> None:
    with pytest.raises(TypeError, match="Canonical mapping keys must be strings"):
        canonical_json_bytes({1: "value"})


def test_canonical_sha256_is_stable_across_equivalent_timezones() -> None:
    eastern = datetime(2026, 8, 15, 12, 34, 56, 123456, tzinfo=ZoneInfo("America/New_York"))
    utc = datetime(2026, 8, 15, 16, 34, 56, 123456, tzinfo=UTC)
    offset = datetime(2026, 8, 15, 12, 34, 56, 123456, tzinfo=timezone(timedelta(hours=-4)))

    digest = canonical_sha256({"granted_at": eastern})
    expected = b'{"granted_at":"2026-08-15T16:34:56.123456Z"}'
    assert canonical_sha256({"granted_at": utc}) == digest
    assert canonical_sha256({"granted_at": offset}) == digest
    assert canonical_json_bytes({"granted_at": utc}) == expected
