"""Synthetic capture control-plane load workload.

Run only against the local E2E host and a disposable PostgreSQL database.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from uuid import uuid4

from locust import HttpUser, between, events, task
from support import (
    DEFAULT_HOST,
    TENANT_ID,
    WRAPPED_DEK,
    Thresholds,
    require_local_host,
    threshold_failures,
)

PROTOCOL_VERSION = "1.0"
CHANNEL = "microphone"
CIPHERTEXT_SIZE_BYTES = 4096
CHUNKS_PER_SESSION = int(os.getenv("SCRIBE_LOAD_CHUNKS_PER_SESSION", "4"))
THRESHOLDS = Thresholds.from_env()

if CHUNKS_PER_SESSION < 1:
    raise ValueError("SCRIBE_LOAD_CHUNKS_PER_SESSION must be at least 1")


def _idem(prefix: str) -> str:
    return f"load-{prefix}-{uuid4()}"


class CaptureProtocolUser(HttpUser):
    """One task is one independent synthetic capture session.

    Request order mirrors the browser capture controller and upload queue; the
    storage PUT is out of scope.
    """

    wait_time = between(0.05, 0.2)
    host = DEFAULT_HOST

    def on_start(self) -> None:
        self.client.headers.update({"X-Tenant-ID": TENANT_ID})

    def post_json(self, path: str, body: dict[str, object], name: str):
        # Encode before the call so JSON serialisation is not counted as request latency.
        payload = json.dumps(body).encode()
        headers = {"Content-Type": "application/json", "Idempotency-Key": _idem(name)}
        return self.client.post(path, data=payload, headers=headers, name=name)

    @task
    def capture_session(self) -> None:
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

        # The client renews only on a paused-then-resumed capture, then reserves
        # the remaining window under the new generation; split the session there.
        first_window = max(1, CHUNKS_PER_SESSION // 2)
        if not self.upload_window(session_id, lease_body, 0, first_window):
            return
        renewed = self.post_json(
            f"/v1/sessions/{session_id}/capture-leases/{lease_body['lease_id']}/renew",
            {"protocol_version": PROTOCOL_VERSION, "expected_generation": lease_body["generation"]},
            "POST lease renew",
        )
        if not renewed.ok:
            return
        lease_body = renewed.json()
        remaining = CHUNKS_PER_SESSION - first_window
        if remaining and not self.upload_window(session_id, lease_body, first_window, remaining):
            return
        self.post_json(
            f"/v1/sessions/{session_id}/capture-complete",
            {
                "protocol_version": PROTOCOL_VERSION,
                "capture_lease_id": lease_body["lease_id"],
                "capture_lease_generation": lease_body["generation"],
                "channels": [{"channel": CHANNEL, "final_sequence_number": CHUNKS_PER_SESSION - 1}],
            },
            "POST capture complete",
        )

    def upload_window(
        self, session_id: str, lease: dict[str, object], first_sequence: int, count: int
    ) -> bool:
        reservations = self.post_json(
            f"/v1/sessions/{session_id}/chunk-reservations",
            {
                "protocol_version": PROTOCOL_VERSION,
                "capture_lease_id": lease["lease_id"],
                "capture_lease_generation": lease["generation"],
                "channel": CHANNEL,
                "first_sequence_number": first_sequence,
                "count": count,
            },
            "POST reservations",
        )
        if not reservations.ok:
            return False
        for reservation in reservations.json()["reservations"]:
            object_id = reservation["object_id"]
            receipt_path = f"/v1/sessions/{session_id}/chunks/{object_id}"
            if not self.client.get(receipt_path, name="GET chunk receipt").ok:
                return False
            authorization = self.post_json(
                f"{receipt_path}/upload-authorization",
                {"protocol_version": PROTOCOL_VERSION},
                "POST upload authorization",
            )
            if not authorization.ok:
                return False
            if not self.client.get(receipt_path, name="GET chunk receipt").ok:
                return False
            registration = self.post_json(
                f"/v1/sessions/{session_id}/chunks",
                {
                    "object_id": object_id,
                    "channel": CHANNEL,
                    "sequence_number": reservation["sequence_number"],
                    "sha256": hashlib.sha256(object_id.encode()).hexdigest(),
                    "ciphertext_size_bytes": CIPHERTEXT_SIZE_BYTES,
                },
                "POST chunk registration",
            )
            if not registration.ok:
                return False
        return True


@events.init.add_listener
def refuse_non_local_target(environment, web_ui=None, **_kwargs) -> None:
    """Abort before any user spawns; locust exits 1 when an init listener raises."""

    if web_ui is not None:
        # The web UI can retarget the host at swarm time, after this check.
        raise RuntimeError("load workload runs headless only")
    require_local_host(environment.host or CaptureProtocolUser.host)


@events.quitting.add_listener
def enforce_thresholds(environment, **_kwargs) -> None:
    """Make headless runs fail when minimum evidence or SLO gates are missed.

    Locust exits with --exit-code-on-error (1) on any request failure unless
    process_exit_code is set, so a passing run must set 0 explicitly.
    """

    stats = environment.stats
    failures = threshold_failures(stats.total, stats.entries.values(), THRESHOLDS)
    environment.process_exit_code = 1 if failures else 0
    if failures:
        print("load thresholds failed: " + "; ".join(failures))
