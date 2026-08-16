from __future__ import annotations

from .schemas import (
    ConsentRecord,
    DeliveryConsentSource,
    DeliverySessionSource,
    SessionCreate,
)


class ConsentError(ValueError):
    pass


class ConsentPolicy:
    """Conservative policy until a counsel-approved jurisdiction matrix exists."""

    version = "all-party-v1"

    def validate_new_record(self, all_parties_consented: bool) -> None:
        if not all_parties_consented:
            raise ConsentError("All-party consent is required before capture.")

    def validate_session(self, consent: ConsentRecord, session: SessionCreate) -> None:
        self._validate_binding(consent, session)

    def validate_delivery_source(
        self,
        consent: DeliveryConsentSource,
        session: DeliverySessionSource,
    ) -> None:
        self._validate_binding(consent, session)

    def _validate_binding(
        self,
        consent: ConsentRecord | DeliveryConsentSource,
        session: SessionCreate | DeliverySessionSource,
    ) -> None:
        if consent.revoked_at is not None or not consent.all_parties_consented:
            raise ConsentError("The consent record is not valid for capture.")
        if (
            consent.appointment_id != session.appointment_id
            or consent.practitioner_id != session.practitioner_id
            or consent.patient_id != session.patient_id
            or consent.modality != session.modality
        ):
            raise ConsentError("The consent record does not match this capture session.")
