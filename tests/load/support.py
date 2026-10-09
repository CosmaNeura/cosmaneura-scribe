"""Side-effect-free safety configuration for the capture load workload."""

from __future__ import annotations

import base64
import json
import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from uuid import UUID

_TENANT_SOURCE = (
    Path(__file__).resolve().parents[2] / "apps/capture/e2e/support/synthetic-tenant.mjs"
)
_TENANT_MATCH = re.search(r'SYNTHETIC_TENANT_ID = "([0-9a-f-]{36})"', _TENANT_SOURCE.read_text())
if _TENANT_MATCH is None:
    raise RuntimeError(f"synthetic tenant is not declared in {_TENANT_SOURCE}")
TENANT_ID = str(UUID(_TENANT_MATCH.group(1)))
WRAPPED_DEK = base64.urlsafe_b64encode(b"k" * 384).rstrip(b"=").decode()
DEFAULT_HOST = "http://127.0.0.1:4175"
LOCAL_HOSTS = frozenset({DEFAULT_HOST, "http://localhost:4175"})


def require_local_host(host: str | None) -> None:
    if host not in LOCAL_HOSTS:
        raise RuntimeError("load workload is restricted to the local synthetic E2E host")


class OperationStats(Protocol):
    name: str
    num_requests: int
    fail_ratio: float

    def get_response_time_percentile(self, percent: float) -> float | None: ...


@dataclass(frozen=True)
class Thresholds:
    min_requests: int = 100
    max_failure_ratio: float = 0.01
    max_p95_ms: float = 750
    operation_max_p95_ms: Mapping[str, float] = field(default_factory=dict)

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Thresholds:
        overrides = json.loads(env.get("SCRIBE_LOAD_OPERATION_MAX_P95_MS", "{}"))
        if not isinstance(overrides, dict):
            raise ValueError("SCRIBE_LOAD_OPERATION_MAX_P95_MS must be a JSON object")
        return cls(
            min_requests=int(env.get("SCRIBE_LOAD_MIN_REQUESTS", "100")),
            max_failure_ratio=float(env.get("SCRIBE_LOAD_MAX_FAILURE_RATIO", "0.01")),
            max_p95_ms=float(env.get("SCRIBE_LOAD_MAX_P95_MS", "750")),
            operation_max_p95_ms={str(name): float(ms) for name, ms in overrides.items()},
        )


def threshold_failures(
    total: OperationStats,
    operations: Iterable[OperationStats],
    thresholds: Thresholds,
) -> list[str]:
    failures = []
    if total.num_requests < thresholds.min_requests:
        failures.append(f"requests {total.num_requests} < {thresholds.min_requests}")
    if total.fail_ratio > thresholds.max_failure_ratio:
        failures.append(
            f"failure ratio {total.fail_ratio:.4f} > {thresholds.max_failure_ratio:.4f}"
        )
    p95 = total.get_response_time_percentile(0.95) or 0
    if p95 > thresholds.max_p95_ms:
        failures.append(f"aggregate p95 {p95}ms > {thresholds.max_p95_ms}ms")
    for operation in sorted(operations, key=lambda entry: entry.name):
        if operation.num_requests == 0:
            continue
        limit = thresholds.operation_max_p95_ms.get(operation.name, thresholds.max_p95_ms)
        p95 = operation.get_response_time_percentile(0.95) or 0
        if p95 > limit:
            failures.append(f"{operation.name} p95 {p95}ms > {limit}ms")
    return failures
