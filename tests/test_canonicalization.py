from __future__ import annotations

from datetime import UTC, datetime

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
