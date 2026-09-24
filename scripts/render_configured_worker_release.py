"""Render complete, disabled ACA job definitions from reviewed non-secret bindings.

No Azure login, credentials, reads, writes, deployment, or job start. Inputs must
name the reviewed private staging worker environment and distinct managed identities. Outputs
are new local files. Enablement is deliberately not a renderer option.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
from pathlib import Path
from uuid import UUID

_ASSEMBLY = "/mnt/encrypted-assembly"


def require(value: object) -> None:
    if not value:
        raise ValueError("worker_binding_invalid")


def checked_bindings(path: Path) -> dict:
    data = json.loads(path.read_text())
    require(data["schema"] == 1)
    require(
        data["environment_id"] == (
            "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13"
            "/resourceGroups/cosmaneura-staging"
            "/providers/Microsoft.App/managedEnvironments"
            "/cosmaneura-staging-scribe-workers-environment"
        )
        and data["environment_name"] == "cosmaneura-staging-scribe-workers-environment"
        and data["location"] == "northcentralus"
    )
    require(re.fullmatch("[a-z0-9]+\\.azurecr\\.io/[^@]+@sha256:[0-9a-f]{64}", data["image"]))
    require(UUID(data["tenant_id"]).int)
    require(re.fullmatch("[a-z0-9-]+\\.postgres\\.database\\.azure\\.com", data["database_host"]))
    require(re.fullmatch("[a-zA-Z_][a-zA-Z0-9_]{0,62}", data["database_name"]))
    identities = []
    for phase in ("speech", "translation"):
        worker = data[phase]
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


def definition(data: dict, phase: str) -> dict:
    worker = data[phase]
    env = {
        "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
        "COSMANEURA_SCRIBE_CAPTURED_WORKER_ENABLED": "false",
        "COSMANEURA_SCRIBE_CAPTURED_WORKER_STAGE": phase,
        "COSMANEURA_SCRIBE_CAPTURED_WORKER_BATCH_SIZE": "8",
        "COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS": json.dumps([data["tenant_id"]]),
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
    principal = "TRANSCRIPTION" if phase == "speech" else "TRANSLATION"
    env[f"COSMANEURA_SCRIBE_DATABASE_{principal}_PRINCIPAL_NAME"] = worker["principal_name"]
    env[f"COSMANEURA_SCRIBE_DATABASE_{principal}_PRINCIPAL_OBJECT_ID"] = worker["object_id"]
    container = {
        "name": "worker",
        "image": data["image"],
        "command": ["python", "-m", "cosmaneura_scribe.captured_worker_job_runner"],
        "args": [data["tenant_id"], "--pending"],
        "resources": {"cpu": 0.5, "memory": "1Gi"},
    }
    template = {"containers": [container]}
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
