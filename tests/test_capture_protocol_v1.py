from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from cosmaneura_scribe.capture_protocol_v1 import (
    AUDIO_CHANNELS,
    AUDIO_ENCODING,
    CAPTURE_LEASE_TTL_SECONDS,
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_ENVELOPE_BYTES,
    MAX_RESERVATIONS_PER_BATCH,
    MEDIA_TYPE,
    PROTOCOL_VERSION,
    RESERVATION_PLAINTEXT_BUDGET_BYTES,
    RESERVATION_WINDOW_SECONDS,
    SAMPLE_RATE_HZ,
    TARGET_CHUNK_DURATION_MS,
    UPLOAD_CONCURRENCY,
    EncryptedChunkHeader,
    base64url_encode,
    capture_channel_additional_data,
    capture_channel_additional_data_base64url,
    decode_envelope,
    encode_envelope,
)

ROOT = Path(__file__).resolve().parents[1]
GOLDEN_PATH = ROOT / "protocol/golden/capture_protocol_v1.json"


def _node_binary() -> str:
    configured = os.environ.get("CAPTURE_PROTOCOL_NODE")
    candidates = (
        Path(configured) if configured else None,
        Path(value) if (value := shutil.which("node")) else None,
        Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node",
    )
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return str(candidate)
    raise AssertionError("Node 24 is required for capture-protocol golden-vector verification")


def test_generated_capture_protocol_is_current() -> None:
    subprocess.run(
        [sys.executable, "scripts/generate_capture_protocol.py", "--check"],
        cwd=ROOT,
        check=True,
    )


def test_capture_protocol_capability_constants_are_pinned() -> None:
    assert (
        PROTOCOL_VERSION,
        MEDIA_TYPE,
        AUDIO_ENCODING,
        AUDIO_CHANNELS,
        SAMPLE_RATE_HZ,
        TARGET_CHUNK_DURATION_MS,
    ) == ("1.0", "audio/wav", "pcm_s16le", 1, 16_000, 10_000)
    assert (
        MAX_ENVELOPE_BYTES,
        MAX_CHUNKS,
        MAX_AGGREGATE_PLAINTEXT_BYTES,
        CAPTURE_LEASE_TTL_SECONDS,
        RESERVATION_WINDOW_SECONDS,
        MAX_RESERVATIONS_PER_BATCH,
        UPLOAD_CONCURRENCY,
        RESERVATION_PLAINTEXT_BUDGET_BYTES,
    ) == (327_680, 1_000, 64 * 1_024 * 1_024, 900, 900, 90, 2, 327_680)


def test_python_capture_protocol_matches_golden_vectors() -> None:
    golden = json.loads(GOLDEN_PATH.read_text())
    for vector in golden["vectors"]:
        values = vector["input"]
        aad_arguments = {
            "tenant_id": values["tenant_id"],
            "session_id": values["session_id"],
            "object_id": values["object_id"],
            "sequence_number": values["sequence_number"],
            "channel": values["channel"],
        }
        aad = capture_channel_additional_data(**aad_arguments)
        assert aad.decode("utf-8") == vector["expected"]["aad_utf8"]
        assert (
            capture_channel_additional_data_base64url(**aad_arguments)
            == vector["expected"]["aad_base64url"]
        )
        ciphertext = bytes.fromhex(values["ciphertext_hex"])
        envelope = encode_envelope(
            EncryptedChunkHeader(
                nonce=base64url_encode(bytes.fromhex(values["nonce_hex"])),
            ),
            ciphertext,
        )
        assert base64url_encode(envelope) == vector["expected"]["envelope_base64url"]
        assert hashlib.sha256(envelope).hexdigest() == vector["expected"]["envelope_sha256"]
        header, decoded_ciphertext = decode_envelope(envelope)
        assert header.schema_version == PROTOCOL_VERSION
        assert decoded_ciphertext == ciphertext


def test_typescript_capture_protocol_matches_golden_vectors() -> None:
    node = _node_binary()
    version = subprocess.run(
        [node, "--version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert int(version.removeprefix("v").split(".", maxsplit=1)[0]) >= 24
    subprocess.run(
        [node, "packages/capture-protocol/test/golden-vectors.mjs"],
        cwd=ROOT,
        check=True,
    )
