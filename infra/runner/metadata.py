from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import NoReturn

SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
LINEAGE_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_PLAN_LOG_BYTES = 1024 * 1024

PLAN_TARGET_OR_CONFIGURATION_MARKERS = (
    "error: invalid target",
    "moved resource instances excluded by targeting",
    "reference to undeclared resource",
    "no value for required variable",
    "invalid value for input variable",
    "provider configuration not present",
    "inconsistent dependency lock file",
    "failed to load plugin schemas",
)
PLAN_PROVIDER_REGISTRATION_MARKERS = (
    "missingsubscriptionregistration",
    "noregisteredproviderfound",
    "subscriptionnotregistered",
    "is not registered to use namespace",
    "register the resource provider",
    "microsoft.resources/subscriptions/providers/register/action",
)
PLAN_KEY_VAULT_MARKERS = (
    "azurerm_key_vault_key.audio",
    "key vault",
    "keyvault",
    "vault.azure.net",
)
PLAN_NETWORK_OR_DNS_MARKERS = (
    "forbiddenbyfirewall",
    "forbiddenbyconnection",
    "public network access is disabled",
    "public-network-disabled",
    "no such host",
    "name resolution",
    "connection refused",
    "connection reset",
    "network is unreachable",
    "network unreachable",
    "i/o timeout",
    "tls handshake timeout",
    "client timeout",
    "context deadline exceeded",
)
PLAN_API_READ_MARKERS = (
    "microsoft.app/containerapps/read",
    "retrieving container app",
    "reading container app",
)
PLAN_IDENTITY_OR_RBAC_MARKERS = (
    "authorizationfailed",
    "forbiddenbyrbac",
    "caller is not authorized",
    "statuscode=401",
    "statuscode=403",
    "status code 401",
    "status code 403",
    "unauthorized",
    "managed identity credential unavailable",
    "managedidentitycredential authentication failed",
    "failed to acquire token",
    "token acquisition failed",
    "authentication failed",
)


def _fail() -> NoReturn:
    raise SystemExit(1)


def _load(path: str) -> object:
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def _read_field(path: str, field: str, expected_type: str) -> None:
    document = _load(path)
    if not isinstance(document, dict) or field not in document:
        _fail()
    value = document[field]
    if expected_type == "string" and type(value) is str:
        print(value)
        return
    if expected_type == "integer" and type(value) is int:
        print(value)
        return
    _fail()


def _write_manifest(path: str, plan_sha256: str, state_lineage: str, state_serial: str) -> None:
    if not SHA256_PATTERN.fullmatch(plan_sha256):
        _fail()
    if not LINEAGE_PATTERN.fullmatch(state_lineage):
        _fail()
    if not state_serial.isdigit():
        _fail()
    document = {
        "format_version": 1,
        "plan_sha256": plan_sha256,
        "state_lineage": state_lineage,
        "state_serial": int(state_serial),
    }
    Path(path).write_text(
        json.dumps(document, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _contains_any(text: str, markers: tuple[str, ...]) -> bool:
    return any(marker in text for marker in markers)


def _classify_plan_error(path: str) -> None:
    with Path(path).open("rb") as stream:
        stream.seek(0, 2)
        size = stream.tell()
        stream.seek(max(0, size - MAX_PLAN_LOG_BYTES))
        text = stream.read(MAX_PLAN_LOG_BYTES).decode("utf-8", errors="replace").casefold()

    error_class = "PlanFailed"
    if _contains_any(text, PLAN_TARGET_OR_CONFIGURATION_MARKERS):
        error_class = "PlanTargetOrConfigurationFailed"
    elif _contains_any(text, PLAN_PROVIDER_REGISTRATION_MARKERS):
        error_class = "PlanProviderRegistrationFailed"
    elif _contains_any(text, PLAN_KEY_VAULT_MARKERS) and _contains_any(
        text, PLAN_NETWORK_OR_DNS_MARKERS
    ):
        error_class = "PlanKeyVaultNetworkOrDnsFailed"
    elif _contains_any(text, PLAN_API_READ_MARKERS):
        error_class = "PlanApiReadFailed"
    elif _contains_any(text, PLAN_IDENTITY_OR_RBAC_MARKERS):
        error_class = "PlanIdentityOrRbacFailed"
    print(error_class)


def main(arguments: list[str]) -> None:
    try:
        if len(arguments) == 4 and arguments[0] == "read-field":
            _read_field(arguments[1], arguments[2], arguments[3])
            return
        if len(arguments) == 5 and arguments[0] == "write-manifest":
            _write_manifest(*arguments[1:])
            return
        if len(arguments) == 2 and arguments[0] == "classify-plan-error":
            _classify_plan_error(arguments[1])
            return
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        _fail()
    _fail()


if __name__ == "__main__":
    main(sys.argv[1:])
