"""Render complete, disabled ACA job definitions from reviewed non-secret bindings.

No Azure login, credentials, reads, writes, deployment, or job start. Inputs must
name the reviewed private staging worker environment and distinct managed identities. Outputs
are new local files. Worker enablement is deliberately not a renderer option. Schema 2 may render
the existing bounded cohort mode, with both jobs still disabled.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
from pathlib import Path
from typing import Any, cast
from uuid import UUID

_ASSEMBLY = "/mnt/encrypted-assembly"
_COMMON_FIELDS = {
    "schema",
    "environment_id",
    "environment_name",
    "location",
    "image",
    "database_host",
    "database_name",
    "speech",
    "translation",
}
_WORKER_FIELDS = {
    "client_id",
    "object_id",
    "principal_name",
    "identity_resource_id",
    "private_host_cidr",
    "key_id",
    "endpoint",
}
_COHORT_FLAG = "configured_capture_multi_tenant_enabled"


def require(value: object) -> None:
    if not value:
        raise ValueError("worker_binding_invalid")


def unique_json(pairs: list[tuple[str, object]]) -> dict[str, object]:
    data: dict[str, object] = {}
    for key, value in pairs:
        require(key not in data)
        data[key] = value
    return data


def capture_tenants(data: object) -> list[str]:
    require(type(data) is dict)
    bindings = cast("dict[str, object]", data)
    require(type(bindings.get("schema")) is int)
    if bindings["schema"] == 1:
        require(set(bindings) == _COMMON_FIELDS | {"tenant_id"})
        tenant = bindings["tenant_id"]
        require(type(tenant) is str)
        legacy_tenant = cast(str, tenant)
        require(UUID(legacy_tenant).int)
        # Retain every existing accepted schema-1 UUID spelling and output byte.
        return [legacy_tenant]
    require(bindings["schema"] == 2)
    require(set(bindings) == _COMMON_FIELDS | {_COHORT_FLAG, "tenant_ids"})
    require(bindings[_COHORT_FLAG] is True)
    raw_tenants = bindings["tenant_ids"]
    require(type(raw_tenants) is list)
    tenants = cast("list[object]", raw_tenants)
    require(1 <= len(tenants) <= 32)
    result: list[str] = []
    for tenant in tenants:
        require(type(tenant) is str)
        canonical_tenant = cast(str, tenant)
        require(str(UUID(canonical_tenant)) == canonical_tenant and UUID(canonical_tenant).int)
        result.append(canonical_tenant)
    require(len(set(result)) == len(result))
    return result


def checked_bindings(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(), object_pairs_hook=unique_json)
    capture_tenants(raw)
    data = cast("dict[str, Any]", raw)
    require(
        data["environment_id"]
        == (
            "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13"
            "/resourceGroups/cosmaneura-staging"
            "/providers/Microsoft.App/managedEnvironments"
            "/cosmaneura-staging-scribe-workers-environment"
        )
        and data["environment_name"] == "cosmaneura-staging-scribe-workers-environment"
        and data["location"] == "northcentralus"
    )
    require(re.fullmatch("[a-z0-9]+\\.azurecr\\.io/[^@]+@sha256:[0-9a-f]{64}", data["image"]))
    require(re.fullmatch("[a-z0-9-]+\\.postgres\\.database\\.azure\\.com", data["database_host"]))
    require(re.fullmatch("[a-zA-Z_][a-zA-Z0-9_]{0,62}", data["database_name"]))
    identities: list[dict[str, Any]] = []
    for phase in ("speech", "translation"):
        raw_worker = data[phase]
        require(type(raw_worker) is dict)
        worker = cast("dict[str, Any]", raw_worker)
        expected = _WORKER_FIELDS | (
            {"storage_url", "container"} if phase == "speech" else {"deployment"}
        )
        require(set(worker) == expected)
        require(UUID(worker["client_id"]).int and UUID(worker["object_id"]).int)
        require(re.fullmatch("[A-Za-z0-9_-]{1,63}", worker["principal_name"]))
        require(
            re.fullmatch(
                "/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/Microsoft.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9_-]+",
                worker["identity_resource_id"],
            )
        )
        identities.append(worker)
        host = ipaddress.ip_network(worker["private_host_cidr"])
        require(host.prefixlen == host.max_prefixlen and host.is_private and (not host.is_loopback))
        require(
            re.fullmatch(
                "https://[a-z0-9-]+\\.vault\\.azure\\.net/keys/[A-Za-z0-9-]+", worker["key_id"]
            )
        )
    for key in ("client_id", "object_id", "principal_name", "identity_resource_id"):
        require(identities[0][key] != identities[1][key])
    require(
        re.fullmatch(
            "https://[a-z0-9-]+\\.cognitiveservices\\.azure\\.com", data["speech"]["endpoint"]
        )
    )
    require(
        re.fullmatch(
            "https://[a-z0-9]{3,24}\\.blob\\.core\\.windows\\.net", data["speech"]["storage_url"]
        )
    )
    require(re.fullmatch("[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", data["speech"]["container"]))
    require(
        re.fullmatch(
            "https://[a-z0-9-]+\\.(openai\\.azure\\.com|services\\.ai\\.azure\\.com)/openai/v1",
            data["translation"]["endpoint"],
        )
    )
    require(re.fullmatch("[A-Za-z0-9][A-Za-z0-9._-]{0,127}", data["translation"]["deployment"]))
    return data


def definition(data: dict[str, Any], phase: str) -> dict[str, Any]:
    require(phase in ("speech", "translation"))
    tenants = capture_tenants(data)
    worker = data[phase]
    env = {
        "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
        "COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED": "false",
        "COSMANEURA_SCRIBE_CAPTURED_WORKER_STAGE": phase,
        "COSMANEURA_SCRIBE_CAPTURED_WORKER_BATCH_SIZE": "8",
        "COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS": json.dumps(tenants),
        "COSMANEURA_SCRIBE_REPOSITORY_BACKEND": "postgres",
        "COSMANEURA_SCRIBE_DATABASE_HOST": data["database_host"],
        "COSMANEURA_SCRIBE_DATABASE_NAME": data["database_name"],
        "COSMANEURA_SCRIBE_DATABASE_USER": worker["principal_name"],
        "COSMANEURA_SCRIBE_DATABASE_SSL": "true",
        "COSMANEURA_SCRIBE_DATABASE_POOL_SIZE": "1",
        "COSMANEURA_SCRIBE_DATABASE_MAX_OVERFLOW": "0",
        "COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID": worker["client_id"],
        "COSMANEURA_SCRIBE_AUDIO_ENCRYPTION_KEY_ID": worker["key_id"],
        "COSMANEURA_SCRIBE_TRANSCRIPTION_JOB_ENABLED": "false",
        "COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_ENABLED": "false",
        "COSMANEURA_SCRIBE_EXTERNAL_INGEST_ADMISSION_ENABLED": "false",
    }
    if data["schema"] == 2:
        env["COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_MULTI_TENANT_ENABLED"] = "true"
    principal = "TRANSCRIPTION" if phase == "speech" else "TRANSLATION"
    env[f"COSMANEURA_SCRIBE_DATABASE_{principal}_PRINCIPAL_NAME"] = worker["principal_name"]
    env[f"COSMANEURA_SCRIBE_DATABASE_{principal}_PRINCIPAL_OBJECT_ID"] = worker["object_id"]
    container: dict[str, Any] = {
        "name": "worker",
        "image": data["image"],
        "command": ["python", "-m", "cosmaneura_scribe.captured_worker_job_runner"],
        "args": ["--cohort-pending"] if data["schema"] == 2 else [data["tenant_id"], "--pending"],
        "resources": {"cpu": 0.5, "memory": "1Gi"},
    }
    template: dict[str, Any] = {"containers": [container]}
    if phase == "speech":
        env.update(
            {
                "COSMANEURA_SCRIBE_STORAGE_BACKEND": "azure",
                "COSMANEURA_SCRIBE_STORAGE_ACCOUNT_URL": worker["storage_url"],
                "COSMANEURA_SCRIBE_STORAGE_CONTAINER_NAME": worker["container"],
                "COSMANEURA_SCRIBE_TRANSCRIPTION_BACKEND": "azure",
                "COSMANEURA_SCRIBE_AZURE_SPEECH_ENDPOINT": worker["endpoint"],
                "COSMANEURA_SCRIBE_AZURE_SPEECH_PRIVATE_ENDPOINT_CIDRS": json.dumps(
                    [worker["private_host_cidr"]]
                ),
                "COSMANEURA_SCRIBE_AUDIO_ASSEMBLY_ENCRYPTED_TEMP_DIRECTORY": _ASSEMBLY,
            }
        )
        template["volumes"] = [{"name": "encrypted-assembly", "storageType": "EmptyDir"}]
        container["volumeMounts"] = [
            {"volumeName": "encrypted-assembly", "mountPath": "/mnt/encrypted-assembly"}
        ]
    else:
        env.update(
            {
                "COSMANEURA_SCRIBE_STORAGE_BACKEND": "memory",
                "COSMANEURA_SCRIBE_TRANSCRIPTION_BACKEND": "none",
                "COSMANEURA_SCRIBE_AZURE_TRANSLATION_ENDPOINT": worker["endpoint"],
                "COSMANEURA_SCRIBE_AZURE_TRANSLATION_DEPLOYMENT": worker["deployment"],
                "COSMANEURA_SCRIBE_AZURE_TRANSLATION_PRIVATE_ENDPOINT_CIDRS": json.dumps(
                    [worker["private_host_cidr"]]
                ),
            }
        )
    container["env"] = [{"name": key, "value": value} for key, value in sorted(env.items())]
    return {
        "location": data["location"],
        "identity": {
            "type": "UserAssigned",
            "userAssignedIdentities": {worker["identity_resource_id"]: {}},
        },
        "properties": {
            "environmentId": data["environment_id"],
            "workloadProfileName": "Consumption",
            "configuration": {
                "triggerType": "Manual",
                "replicaTimeout": 1800,
                "replicaRetryLimit": 0,
                "manualTriggerConfig": {"parallelism": 1, "replicaCompletionCount": 1},
                "registries": [
                    {
                        "server": data["image"].split("/")[0],
                        "identity": worker["identity_resource_id"],
                    }
                ],
            },
            "template": template,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        bindings = checked_bindings(args.bindings)
        rendered = {phase: definition(bindings, phase) for phase in ("speech", "translation")}
    except (AssertionError, KeyError, TypeError, ValueError):
        raise SystemExit("Reviewed staging worker bindings are incomplete or invalid.") from None
    args.output.mkdir(mode=448)
    for phase, body in rendered.items():
        (args.output / (phase + ".job.json")).write_text(json.dumps(body, indent=2) + "\n")


if __name__ == "__main__":
    main()
