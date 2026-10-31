"""Project explicit owner inputs into receipt-bound build/runtime profiles.

No environment fallback, signing, credential creation, deployment or I/O beyond
one supplied ordinary JSON file and an exclusive output directory. A receipt
reference is not approval. Production remains unqualified pending the flight plan.
"""

from __future__ import annotations

import argparse
import base64
import json
import plistlib
import re
from pathlib import Path

from receiver_runtime import ReceiverConfiguration


def project(value: dict, *, enable_clients: bool = False) -> dict:
    if type(enable_clients) is not bool:
        raise ValueError("production_profile_input_invalid")
    if set(value) != {"schema", "receiver", "client", "desktop_helpers"} or value["schema"] != 1:
        raise ValueError("production_profile_input_invalid")
    receiver = value["receiver"]
    if not isinstance(receiver, dict) or receiver.get("enabled") is not False:
        raise ValueError("production_profile_input_invalid")
    # Require all activation bindings without creating an active runtime.
    config = ReceiverConfiguration.model_validate_json(json.dumps({**receiver, "enabled": True}))
    if config.profile != "core-production-organization-v1" or config.production is None:
        raise ValueError("production_profile_input_invalid")
    if enable_clients and set(config.platforms) != {"ios", "desktop"}:
        raise ValueError("production_profile_input_invalid")
    client = value["client"]
    if not isinstance(client, dict) or set(client) != {
        "publishable_key",
        "upload_origin",
        "workspace_id",
    }:
        raise ValueError("production_profile_input_invalid")
    key, upload, workspace = (
        client[k] for k in ("publishable_key", "upload_origin", "workspace_id")
    )
    if (
        not isinstance(key, str)
        or not key.startswith("pk_live_")
        or len(key) > 1024
        or not isinstance(upload, str)
        or not re.fullmatch(r"https://[a-z0-9]{3,24}\.blob\.core\.windows\.net", upload)
        or workspace != str(config.beta_box_id)
        or workspace == "56f527ab-0caf-459b-bda9-cf7f0ca2f709"
    ):
        raise ValueError("production_profile_input_invalid")
    encoded = key[8:].replace("-", "+").replace("_", "/")
    if (
        base64.b64decode(encoded + "=" * ((4 - len(encoded) % 4) % 4), validate=True)
        != b"clerk.cosmaneura.com$"
    ):
        raise ValueError("production_profile_input_invalid")
    helpers = value["desktop_helpers"]
    if not isinstance(helpers, dict) or set(helpers) != {"auth", "audio", "presentation"}:
        raise ValueError("production_profile_input_invalid")
    for helper in helpers.values():
        if (
            not isinstance(helper, dict)
            or set(helper) != {"path", "sha256"}
            or not isinstance(helper["path"], str)
            or "\\" in helper["path"]
            or helper["path"].startswith("/")
            or any(part in {"", ".", ".."} for part in helper["path"].split("/"))
            or not isinstance(helper["sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", helper["sha256"])
        ):
            raise ValueError("production_profile_input_invalid")
    auth = {
        "enabled": enable_clients,
        "identityProfile": "clerk-organization-v1",
        "publishableKey": key,
        "frontendOrigin": config.production.issuer,
        "organizationId": config.production.organization_id,
        "audience": config.production.audience,
        "sessionClaimsReceiptSha256": config.production.session_claims_receipt_sha256,
        "nativePolicyReceiptSha256": config.production.native_policy_receipt_sha256,
    }
    wire = {
        "profile": "core-production-organization-https-v1",
        "endpoint": config.production.receiver_origin,
    }
    application = {
        "profile": "core-production-organization-v1",
        "enabled": enable_clients,
        "coreOrigin": config.production.core_origin,
        "uploadOrigins": [upload],
    }
    return {
        "receiver": config.model_copy(update={"enabled": False}).model_dump(
            mode="json", by_alias=True
        ),
        "ios": {
            "CFBundleIdentifier": "com.cosmaneura.scribe.beta",
            "CosmasNativeAuth": auth,
            "ScribeProviderReceiver": wire,
            "ScribeProviderApplication": application,
        },
        "desktop_auth": {"CosmasNativeAuth": auth, "ScribeProviderReceiver": wire},
        "desktop": {
            "schema": 2,
            "profile": "core-production-organization-v1",
            "enabled": enable_clients,
            "coreOrigin": config.production.core_origin,
            "workspaceId": workspace,
            "deploymentReceiptSha256": config.production.deployment_receipt_sha256,
            "uploadOrigins": [upload],
            **helpers,
        },
    }


def prepare(source: Path, output: Path, *, enable_clients: bool = False) -> None:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("production_profile_input_invalid")
            result[key] = value
        return result

    if source.is_symlink() or not source.is_file() or source.stat().st_size > 16384:
        raise ValueError("production_profile_input_invalid")
    profiles = project(
        json.loads(source.read_bytes(), object_pairs_hook=unique), enable_clients=enable_clients
    )
    output.mkdir(mode=0o700)
    for name in ("receiver", "desktop"):
        (output / (name + "-profile.json")).write_text(json.dumps(profiles[name], indent=2) + "\n")
    for name in ("ios", "desktop_auth"):
        (output / (name + "-info-fragment.plist")).write_bytes(plistlib.dumps(profiles[name]))
    (output / "compile-definition.txt").write_text("SCRIBE_PRODUCTION_ORGANIZATION\n")
    (output / "status.json").write_text(
        json.dumps(
            {
                "enabled": False,
                "clients_enabled": enable_clients,
                "signed": False,
                "installed": False,
                "deployed": False,
                "production_qualified": False,
            }
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--enable-clients",
        action="store_true",
        help=(
            "Enable only the explicitly bound native client profiles; "
            "receiver and cloud remain unchanged"
        ),
    )
    args = parser.parse_args()
    prepare(args.source, args.output, enable_clients=args.enable_clients)
