"""Side-effect-free safety configuration for the capture load workload."""

from __future__ import annotations

import base64

TENANT_ID = "11111111-1111-4111-8111-111111111112"
WRAPPED_DEK = base64.urlsafe_b64encode(b"k" * 384).rstrip(b"=").decode()
LOCAL_HOSTS = frozenset({"http://127.0.0.1:4175", "http://localhost:4175"})


def require_local_host(host: str) -> None:
    if host not in LOCAL_HOSTS:
        raise RuntimeError("load workload is restricted to the local synthetic E2E host")
