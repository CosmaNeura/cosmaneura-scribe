"""Synthetic capture control-plane load workload.

Run only against the local E2E host and a disposable PostgreSQL database.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from uuid import uuid4

from locust import HttpUser, between, events, task
from support import TENANT_ID, WRAPPED_DEK, require_local_host

PROTOCOL_VERSION = "1.0"
MAX_FAILURE_RATIO = float(os.getenv("SCRIBE_LOAD_MAX_FAILURE_RATIO", "0.01"))
MAX_P95_MS = int(os.getenv("SCRIBE_LOAD_MAX_P95_MS", "750"))
MIN_REQUESTS = int(os.getenv("SCRIBE_LOAD_MIN_REQUESTS", "100"))


def _idem(prefix: str) -> str:
    return f"load-{prefix}-{uuid4()}"


class CaptureProtocolUser(HttpUser):
    """One task is one complete, independent synthetic capture lifecycle."""

    wait_time = between(0.05, 0.2)
    host = "http://127.0.0.1:4175"

    def on_start(self) -> None:
        require_local_host(self.host)
        self.client.headers.update({"X-Tenant-ID": TENANT_ID})

    def post_json(self, path: str, body: dict[str, object], name: str):
        return self.client.post(
            path,
            json=body,
            headers={"Idempotency-Key": _idem(name)},
            name=name,
        )

    @task
    def complete_capture_lifecycle(self) -> None:
        run_id = str(uuid4())
        common = {
            "appointment_id": f"synthetic-appointment-{run_id}",
            "practitioner_id": "synthetic-practitioner",
            "patient_id": f"synthetic-patient-{run_id}",
            "modality": "in_person",
        }
        consent = self.post_json(
            "/v1/consents",
            {
                **common,
                "participant_regions": [],
                "method": "verbal_attestation",
                "all_parties_consented": True,
                "granted_at": datetime.now(UTC).isoformat(),
            },
            "POST consent",
        )
        if not consent.ok:
            return
        session = self.post_json(
            "/v1/sessions",
            {**common, "consent_record_id": consent.json()["id"]},
            "POST session",
        )
        if not session.ok:
            return
        session_id = session.json()["id"]
        key = self.post_json(
            f"/v1/sessions/{session_id}/audio-key",
            {"key_version": "browser-e2e-key", "wrapped_dek": WRAPPED_DEK},
            "POST audio key",
        )
        if not key.ok:
            return
        capabilities = self.client.get(
            f"/v1/sessions/{session_id}/capture-capabilities",
            name="GET capabilities",
        )
        if not capabilities.ok:
            return
        lease = self.post_json(
            f"/v1/sessions/{session_id}/capture-lease",
            {"protocol_version": PROTOCOL_VERSION},
            "POST lease",
        )
        if not lease.ok:
            return
        lease_body = lease.json()
        authority = {
            "protocol_version": PROTOCOL_VERSION,
            "capture_lease_id": lease_body["lease_id"],
            "capture_lease_generation": lease_body["generation"],
        }
        reservations = self.post_json(
            f"/v1/sessions/{session_id}/chunk-reservations",
            {
                **authority,
                "channel": "microphone",
                "first_sequence_number": 0,
                "count": 1,
            },
            "POST reservations",
        )
        if not reservations.ok:
            return
        object_id = reservations.json()["reservations"][0]["object_id"]
        authorization = self.post_json(
            f"/v1/sessions/{session_id}/chunks/{object_id}/upload-authorization",
            {"protocol_version": PROTOCOL_VERSION},
            "POST upload authorization",
        )
        if not authorization.ok:
            return
        chunk = self.post_json(
            f"/v1/sessions/{session_id}/chunks",
            {
                "sequence_number": 0,
                "channel": "microphone",
                "object_id": object_id,
                "sha256": "0" * 64,
                "ciphertext_size_bytes": 4096,
            },
            "POST chunk registration",
        )
        if not chunk.ok:
            return
        self.post_json(
            f"/v1/sessions/{session_id}/capture-complete",
            {
                **authority,
                "channels": [{"channel": "microphone", "final_sequence_number": 0}],
            },
            "POST capture complete",
        )


@events.quitting.add_listener
def enforce_thresholds(environment, **_kwargs) -> None:
    """Make headless runs fail when minimum evidence or SLO gates are missed."""

    stats = environment.stats.total
    failures = []
    if stats.num_requests < MIN_REQUESTS:
        failures.append(f"requests {stats.num_requests} < {MIN_REQUESTS}")
    if stats.fail_ratio > MAX_FAILURE_RATIO:
        failures.append(f"failure ratio {stats.fail_ratio:.4f} > {MAX_FAILURE_RATIO:.4f}")
    p95 = stats.get_response_time_percentile(0.95) or 0
    if p95 > MAX_P95_MS:
        failures.append(f"p95 {p95}ms > {MAX_P95_MS}ms")
    if failures:
        environment.process_exit_code = 1
        print("load thresholds failed: " + "; ".join(failures))
