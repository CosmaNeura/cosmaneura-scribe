"""The API service must silence third-party HTTP loggers, not rely on a default.

`scripts/check_phi_logs.py` proves our own modules never log a clinical payload.
It cannot prove anything about the Azure storage SDK, which logs the URLs it
calls — and a blob URL path carries the object name.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Iterator

import pytest
from cosmaneura_scribe import audio_assembly, storage
from cosmaneura_scribe.safe_logging import (
    _PHI_RISK_LOG_NAMESPACES,
    configure_service_logging,
)

_OBJECT_NAME = "tenant/session/2f8c0b3e-object-name.webm"


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    saved = {
        name: (
            logging.getLogger(name).disabled,
            logging.getLogger(name).propagate,
            list(logging.getLogger(name).handlers),
        )
        for name in _PHI_RISK_LOG_NAMESPACES
    }
    root = logging.getLogger()
    saved_root = (root.level, list(root.handlers))
    yield
    for name, (disabled, propagate, handlers) in saved.items():
        logger = logging.getLogger(name)
        logger.disabled = disabled
        logger.propagate = propagate
        logger.handlers[:] = handlers
    root.setLevel(saved_root[0])
    root.handlers[:] = saved_root[1]


@pytest.mark.parametrize("namespace", _PHI_RISK_LOG_NAMESPACES)
def test_third_party_namespace_cannot_emit(
    namespace: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_service_logging()

    # The shape the Azure SDK's HTTP logging policy would emit at DEBUG.
    logging.getLogger(f"{namespace}.core.pipeline").debug(
        "Request URL: 'https://acct.blob.core.windows.net/audio/%s'", _OBJECT_NAME
    )
    logging.getLogger(namespace).warning("Request URL: %s", _OBJECT_NAME)

    captured = capsys.readouterr()
    assert _OBJECT_NAME not in captured.out
    assert _OBJECT_NAME not in captured.err
    assert logging.getLogger(namespace).disabled is True


def test_root_logger_is_left_alone() -> None:
    """Unlike the acceptance job, the service must keep uvicorn's error path usable."""

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    sentinel = logging.NullHandler()
    root.addHandler(sentinel)

    configure_service_logging()

    assert sentinel in root.handlers
    assert root.level == logging.INFO


@pytest.mark.parametrize(
    "source",
    [
        inspect.getsource(audio_assembly.AzureBlobObjectReader.__init__),
        inspect.getsource(storage),
    ],
)
def test_blob_clients_disable_sdk_http_logging(source: str) -> None:
    """Object names live in the blob URL path; the SDK logger must never see them."""

    assert "BlobServiceClient(" in source
    assert "logging_enable=False" in source
