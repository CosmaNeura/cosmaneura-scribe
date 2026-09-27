from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


def _load_module():
    path = Path(__file__).parent / "load" / "support.py"
    spec = importlib.util.spec_from_file_location("capture_load_support", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_workload_rejects_non_loopback_host() -> None:
    module = _load_module()

    with pytest.raises(RuntimeError, match="restricted to the local synthetic E2E host"):
        module.require_local_host("https://example.invalid")


def test_wrapped_key_has_rsa_3072_length() -> None:
    module = _load_module()
    padding = "=" * (-len(module.WRAPPED_DEK) % 4)

    import base64

    assert len(base64.urlsafe_b64decode(module.WRAPPED_DEK + padding)) == 384
