"""Manual paired-artifact publication/dark promotion; no build or activation.

Plan modes are read-only. Mutation modes are founder-only interactive operations;
agents must never invoke them. See docs/production/paired-image-release.md.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tarfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

SUBSCRIPTION = "bab2a709-1fcb-4c87-a9fc-802f7477ec13"
GROUP = "cosmaneura-prod"
REGISTRY = "cosmaneuraprodregistry"
REPOSITORY = "cosmaneura/cosmaneura"
IMAGE_PREFIX = f"{REGISTRY}.azurecr.io/{REPOSITORY}"
CORE_ID = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}"
REGISTRY_ID = f"{CORE_ID}/providers/Microsoft.ContainerRegistry/registries/{REGISTRY}"
CORE_REPO = "CosmaNeura/cosmaneura"
SCRIBE_REPO = "CosmaNeura/cosmaneura-scribe"
FOUNDER = "JohnClem"
HOSTS = {
    "cosmaneura-prod-app": "cosmaneura-prod-app-web",
    "cosmaneura-prod-worker": "cosmaneura-prod-app-worker",
    "cosmaneura-prod-scheduler": "cosmaneura-prod-app-scheduler",
}
FLAGS = ("SCRIBE_BUNDLE_API_ENABLED", "SCRIBE_BUNDLE_CAPTURED_WORKER_ENABLED")
# These are the sealed receiver/bundle inputs, not this later publication tool.
SCRIBE_INPUTS = (
    "README.md",
    "pyproject.toml",
    "uv.lock",
    "services/api",
    "deployment",
    "scripts/standalone-provider",
    "docs/production/production-native-organization-policy.patch",
)
HEX = re.compile(r"[0-9a-f]{64}")
REVISION = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
QUALIFICATION = {
    "core_processes_passed",
    "child_env_i_uid10001_passed",
    "disabled_profiles_passed",
    "disabled_workers_passed",
    "sealed_source_passed",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def fingerprint(value: Any) -> str:
    return digest(canonical(value))


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_field")
        result[key] = value
    return result


def decode(data: bytes) -> Any:
    return json.loads(data, object_pairs_hook=unique_object)


def regular(path: Path) -> None:
    if not path.is_absolute() or path.resolve() != path or not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("regular_canonical_file_required")


def file_hash(path: Path) -> str:
    regular(path)
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def document(path: Path, expected: str) -> dict[str, Any]:
    regular(path)
    if not HEX.fullmatch(expected) or path.stat().st_size > 512_000:
        raise ValueError("review_document_invalid")
    data = path.read_bytes()
    if digest(data) != expected:
        raise ValueError("review_document_changed")
    result = decode(data)
    if not isinstance(result, dict):
        raise ValueError("review_document_invalid")
    return result


def verify_review(review: dict[str, Any]) -> None:
    required = {
        "schema",
        "core_revision",
        "core_tree",
        "scribe_revision",
        "scribe_tree",
        "archive_sha256",
        "archive_bytes",
        "image_digest",
        "config_digest",
        "core_base_digest",
        "core_base_layers",
        "core_runtime_sha256",
        "qualification",
        "independent_evidence_sha256",
    }
    if set(review) != required or review["schema"] != "paired-production-artifact-v1":
        raise ValueError("artifact_review_contract_invalid")
    if (
        any(
            not REVISION.fullmatch(review[key])
            for key in (
                "core_revision",
                "core_tree",
                "scribe_revision",
                "scribe_tree",
            )
        )
        or any(
            not HEX.fullmatch(review[key])
            for key in (
                "archive_sha256",
                "core_runtime_sha256",
                "independent_evidence_sha256",
            )
        )
        or any(
            not DIGEST.fullmatch(review[key])
            for key in (
                "image_digest",
                "config_digest",
                "core_base_digest",
            )
        )
    ):
        raise ValueError("artifact_provenance_invalid")
    if (
        type(review["archive_bytes"]) is not int
        or not 0 < review["archive_bytes"] < 8 * 1024**3
        or not isinstance(review["core_base_layers"], list)
        or not review["core_base_layers"]
        or any(not DIGEST.fullmatch(item) for item in review["core_base_layers"])
        or set(review["qualification"]) != QUALIFICATION
        or any(value is not True for value in review["qualification"].values())
    ):
        raise ValueError("artifact_qualification_incomplete")


def verify_archive(archive: Path, review: dict[str, Any]) -> None:
    """Verify OCI/Docker-save bytes without extracting or executing any file."""
    verify_review(review)
    if (
        archive.stat().st_size != review["archive_bytes"]
        or file_hash(archive) != review["archive_sha256"]
    ):
        raise ValueError("artifact_archive_changed")
    with tarfile.open(archive, mode="r:") as bundle:
        members = bundle.getmembers()
        names = {item.name for item in members}
        if len(names) != len(members) or len(members) > 256:
            raise ValueError("artifact_archive_members_invalid")
        for item in members:
            allowed = item.name in {"index.json", "oci-layout", "manifest.json"} or re.fullmatch(
                r"blobs/sha256/[0-9a-f]{64}",
                item.name,
            )
            if not (item.isdir() and item.name in {"blobs", "blobs/sha256"}) and not (
                item.isfile() and allowed
            ):
                raise ValueError("artifact_archive_members_invalid")

        def read(name: str, limit: int = 128_000) -> bytes:
            member = bundle.getmember(name)
            if not member.isfile() or member.size > limit:
                raise ValueError("artifact_archive_document_invalid")
            stream = bundle.extractfile(member)
            if stream is None:
                raise ValueError("artifact_archive_document_invalid")
            return stream.read()

        if decode(read("oci-layout")) != {"imageLayoutVersion": "1.0.0"}:
            raise ValueError("artifact_layout_invalid")
        index = decode(read("index.json"))
        descriptors = index.get("manifests", [])
        if index.get("schemaVersion") != 2 or len(descriptors) != 1:
            raise ValueError("artifact_single_image_required")
        selected = descriptors[0]
        if selected.get("digest") != review["image_digest"]:
            raise ValueError("artifact_manifest_changed")
        manifest_bytes = read("blobs/sha256/" + review["image_digest"][7:])
        if (
            digest(manifest_bytes) != review["image_digest"][7:]
            or len(manifest_bytes) != selected["size"]
        ):
            raise ValueError("artifact_manifest_changed")
        manifest = decode(manifest_bytes)
        config = manifest["config"]
        if config["digest"] != review["config_digest"]:
            raise ValueError("artifact_config_changed")
        config_bytes = read("blobs/sha256/" + config["digest"][7:])
        image = decode(config_bytes)
        if digest(config_bytes) != config["digest"][7:] or len(config_bytes) != config["size"]:
            raise ValueError("artifact_config_changed")
        labels = image["config"].get("Labels", {})
        runtime = {
            key: image["config"].get(key)
            for key in (
                "User",
                "Env",
                "Cmd",
                "Entrypoint",
                "WorkingDir",
            )
        }
        if (
            image.get("architecture") != "amd64"
            or image.get("os") != "linux"
            or labels.get("com.cosmaneura.core-source-revision") != review["core_revision"]
            or labels.get("com.cosmaneura.scribe-source-revision") != review["scribe_revision"]
            or fingerprint(runtime) != review["core_runtime_sha256"]
        ):
            raise ValueError("artifact_runtime_provenance_changed")
        layers = manifest["layers"]
        # Docker's existing image-load route needs its save-format manifest.
        # This archive may also be an OCI layout; do not depend on an OCI-only
        # loader or an additional publication tool.
        saved = decode(read("manifest.json"))
        if (
            len(saved) != 1
            or saved[0].get("Config") != "blobs/sha256/" + review["config_digest"][7:]
            or saved[0].get("RepoTags") not in (None, [])
            or saved[0].get("Layers") != ["blobs/sha256/" + layer["digest"][7:] for layer in layers]
        ):
            raise ValueError("docker_save_manifest_invalid")
        if [layer["digest"] for layer in layers[: len(review["core_base_layers"])]] != review[
            "core_base_layers"
        ]:
            raise ValueError("artifact_core_layers_changed")
        if len(layers) <= len(review["core_base_layers"]) or len(
            image["rootfs"]["diff_ids"]
        ) != len(layers):
            raise ValueError("artifact_overlay_missing")
        expected_blobs = {review["image_digest"], review["config_digest"]} | {
            layer["digest"] for layer in layers
        }
        if {name[13:] for name in names if name.startswith("blobs/sha256/")} != {
            value[7:] for value in expected_blobs
        }:
            raise ValueError("artifact_extra_or_missing_blob")
        for layer in layers:
            if not DIGEST.fullmatch(layer["digest"]):
                raise ValueError("artifact_layer_invalid")
            member = bundle.getmember("blobs/sha256/" + layer["digest"][7:])
            stream = bundle.extractfile(member)
            if (
                stream is None
                or member.size != layer["size"]
                or hashlib.file_digest(stream, "sha256").hexdigest() != layer["digest"][7:]
            ):
                raise ValueError("artifact_layer_changed")


class Operator:
    """Existing toolchain only; capture subprocess output, never echo credentials/config."""

    def timeout(self, args: list[str]) -> int:
        if args[0] == "docker" and "load" in args:
            return 300
        if (args[0] == "docker" and "push" in args) or args[:3] == ["az", "containerapp", "update"]:
            return 600
        return 60

    def run(self, args: list[str], *, optional_missing: bool = False) -> bytes | None:
        process = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True
        )
        try:
            output, error = process.communicate(timeout=self.timeout(args))
        except subprocess.TimeoutExpired:
            self.stop_owned(process, args[0])
            raise RuntimeError("operator_timeout_unconfirmed:" + args[0]) from None
        except BaseException:
            # Founder Ctrl-C/SystemExit must not leave a CLI mutation running.
            self.stop_owned(process, args[0])
            raise
        if process.returncode:
            # Authentication/transport/authorization failures are never absence.
            if optional_missing and re.search(rb"\b(MANIFEST_UNKNOWN|ManifestUnknown)\b", error):
                return None
            raise RuntimeError("operator_command_failed:" + args[0])
        return output

    def stop_owned(self, process: subprocess.Popen[bytes], command: str) -> None:
        # Only this newly owned session/group, never a shared daemon or UI.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                # An inherited pipe outside the owned group cannot make cleanup
                # unbounded. Close those pipes and reap the process we launched.
                if process.stdout:
                    process.stdout.close()
                if process.stderr:
                    process.stderr.close()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    raise RuntimeError("owned_process_cleanup_unconfirmed:" + command) from None

    def json(self, args: list[str]) -> Any:
        return decode(self.run(args) or b"null")

    def current(self, repository: str, branch: str) -> str:
        return self.json(["gh", "api", f"repos/{repository}/git/ref/heads/{branch}"])["object"][
            "sha"
        ]

    def remote(self, image: str) -> str | None:
        output = self.run(
            [
                "az",
                "acr",
                "repository",
                "show",
                "--name",
                REGISTRY,
                "--image",
                image,
                "--subscription",
                SUBSCRIPTION,
                "--only-show-errors",
                "--output",
                "json",
            ],
            optional_missing=True,
        )
        return None if output is None else decode(output)["digest"]

    def resource(self, name: str) -> dict[str, Any]:
        return self.json(
            [
                "az",
                "containerapp",
                "show",
                "--name",
                name,
                "--resource-group",
                GROUP,
                "--subscription",
                SUBSCRIPTION,
                "--only-show-errors",
                "--output",
                "json",
            ]
        )

    def image(self, name: str, container: str, reference: str) -> None:
        self.run(
            [
                "az",
                "containerapp",
                "update",
                "--name",
                name,
                "--resource-group",
                GROUP,
                "--subscription",
                SUBSCRIPTION,
                "--container-name",
                container,
                "--image",
                reference,
                "--only-show-errors",
                "--output",
                "none",
            ]
        )


class Journal:
    """Exclusive, durable plan marker on the existing operator machine.

    The CLI has one fixed directory; changing output paths cannot replay a plan.
    Tests inject an isolated directory. Reconciliation is founder-held, not an
    automatic delete/resume operation in this tool.
    """

    def __init__(self, proposed: dict[str, Any], *, root: Path | None = None):
        self.root = root or Path.home() / ".cosmaneura-scribe-release-journal"
        self.root.mkdir(mode=0o700, exist_ok=True)
        metadata = self.root.lstat()
        if (
            self.root.resolve() != self.root
            or not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077
        ):
            raise ValueError("private_owned_journal_directory_required")
        self.plan_sha = fingerprint(proposed)
        self.path = self.root / (self.plan_sha + ".jsonl")
        try:
            self.fd = os.open(
                self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
        except FileExistsError:
            raise ValueError("plan_already_attempted_founder_reconciliation_required") from None
        self.append(
            "execution_started",
            {
                "approved_plan_sha256": fingerprint(proposed),
                "action": proposed["action"],
                "image_digest": proposed["artifact"]["image_digest"],
            },
        )
        directory = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def append(self, event: str, details: dict[str, Any] | None = None) -> None:
        data = (
            canonical({"event": event, "utc": datetime.now(UTC).isoformat(), **(details or {})})
            + b"\n"
        )
        position = 0
        while position < len(data):
            written = os.write(self.fd, data[position:])
            if written <= 0:
                raise RuntimeError("journal_write_unconfirmed")
            position += written
        os.fsync(self.fd)

    def close(self) -> None:
        os.close(self.fd)


def git(operator: Operator, repository: Path, *args: str) -> str:
    return (operator.run(["git", "-C", str(repository), *args]) or b"").decode().strip()


def verify_sources(operator: Operator, review: dict[str, Any], core: Path, scribe: Path) -> str:
    for path, repo, branch, key in (
        (core, CORE_REPO, "master", "core"),
        (scribe, SCRIBE_REPO, "main", "scribe"),
    ):
        current = operator.current(repo, branch)
        if git(operator, path, "rev-parse", "HEAD") != current or git(
            operator, path, "status", "--porcelain"
        ):
            raise ValueError("current_clean_merged_source_required")
        original = review[key + "_revision"]
        if git(operator, path, "rev-parse", original + "^{tree}") != review[key + "_tree"]:
            raise ValueError("artifact_source_tree_changed")
        if key == "core" and original != current:
            raise ValueError("core_advanced_rebuild_pair_required")
        if key == "scribe":
            operator.run(["git", "-C", str(path), "merge-base", "--is-ancestor", original, current])
            operator.run(
                ["git", "-C", str(path), "diff", "--quiet", original, current, "--", *SCRIBE_INPUTS]
            )
    return operator.current(SCRIBE_REPO, "main")


def target(review: dict[str, Any]) -> str:
    # Docker tags are limited to 128 characters. The full digest remains the
    # actual publication check and deployment selector, not this short tag suffix.
    return (
        f"{REPOSITORY}:paired-{review['core_revision']}-{review['scribe_revision']}-"
        f"{review['image_digest'][7:23]}"
    )


def projection(resource: dict[str, Any], name: str) -> dict[str, Any]:
    expected_id = f"{CORE_ID}/providers/Microsoft.App/containerApps/{name}"
    if resource.get("id", "").lower() != expected_id.lower() or resource.get("name") != name:
        raise ValueError("existing_resource_required")
    properties = resource["properties"]
    # Exclude service-computed status/revision URLs. Retain every writable field
    # supplied by this API, not merely the fields known when the tool was written.
    status_fields = {
        "provisioningState",
        "runningStatus",
        "latestRevisionName",
        "latestReadyRevisionName",
        "latestRevisionFqdn",
        "outboundIpAddresses",
        "eventStreamEndpoint",
        "customDomainVerificationId",
    }
    result = {
        key: copy.deepcopy(resource.get(key))
        for key in ("id", "name", "location", "tags", "identity")
    }
    result["properties"] = {
        key: copy.deepcopy(value) for key, value in properties.items() if key not in status_fields
    }
    containers = result["properties"]["template"]["containers"]
    if len(containers) != 1 or containers[0]["name"] != HOSTS[name]:
        raise ValueError("exact_existing_container_required")
    env = containers[0].get("env", [])
    values = {item["name"]: item.get("value") for item in env}
    if len(values) != len(env) or any(
        value not in (None, "false") for key, value in values.items() if key in FLAGS
    ):
        raise ValueError("bundle_must_already_be_disabled")
    if any(item["name"] in FLAGS and "secretRef" in item for item in env):
        raise ValueError("bundle_enable_flag_must_be_literal")
    return result


def plan(
    operator: Operator,
    action: str,
    review: dict[str, Any],
    review_sha: str,
    archive: Path,
    core: Path,
    scribe: Path,
    docker_host: str,
    now: datetime,
) -> dict[str, Any]:
    if action not in {"publish", "promote-dark"}:
        raise ValueError("unsupported_action")
    verify_archive(archive, review)
    source = verify_sources(operator, review, core, scribe)
    registry = operator.json(
        [
            "az",
            "acr",
            "show",
            "--name",
            REGISTRY,
            "--subscription",
            SUBSCRIPTION,
            "--output",
            "json",
        ]
    )
    if registry.get("id", "").lower() != REGISTRY_ID.lower():
        raise ValueError("existing_registry_required")
    published = operator.remote(target(review))
    if published not in (None, review["image_digest"]) or (
        action == "promote-dark" and published is None
    ):
        raise ValueError("remote_artifact_missing_or_conflicting")
    snapshots: dict[str, Any] = {}
    if action == "publish":
        # No implicit daemon selection can differ between approval and execution.
        if not docker_host or "\x00" in docker_host:
            raise ValueError("explicit_existing_docker_host_required")
        operator.run(
            ["docker", "--host", docker_host, "version", "--format", "{{.Server.Version}}"]
        )
    else:
        for name in HOSTS:
            resource = projection(operator.resource(name), name)
            snapshots[name] = {
                "configuration_sha256": fingerprint(resource),
                "prior_image": resource["properties"]["template"]["containers"][0]["image"],
            }
    return {
        "schema": "paired-production-plan-v1",
        "action": action,
        "created_utc": now.isoformat(),
        "expires_utc": (now + timedelta(minutes=30)).isoformat(),
        "tool_revision": source,
        "review_sha256": review_sha,
        "artifact": review,
        "target_image": IMAGE_PREFIX + "@" + review["image_digest"],
        "tag": target(review),
        "docker_host": docker_host if action == "publish" else "",
        "existing_hosts": snapshots,
        "drift_disposition": "replace_image_only" if snapshots else "none",
        "activation": False,
        "access_or_configuration_changes": False,
        "new_resources": 0,
        "writes_performed": 0,
    }


def authorize(
    operator: Operator,
    proposed: dict[str, Any],
    expected: str,
    *,
    interactive: bool,
    confirmation: str,
    now: datetime,
) -> str:
    if fingerprint(proposed) != expected or not HEX.fullmatch(expected):
        raise ValueError("exact_plan_approval_required")
    if proposed["schema"] != "paired-production-plan-v1" or proposed["action"] not in {
        "publish",
        "promote-dark",
    }:
        raise ValueError("unsupported_action")
    validate_plan(proposed)
    expires, created = (
        datetime.fromisoformat(proposed["expires_utc"]),
        datetime.fromisoformat(proposed["created_utc"]),
    )
    if not created <= now < expires <= created + timedelta(minutes=30):
        raise ValueError("plan_expired_or_invalid")
    if not (interactive and confirmation == f"{proposed['action'].upper()} {expected}"):
        raise ValueError("interactive_founder_confirmation_required")
    if operator.json(["gh", "api", "user"])["login"] != FOUNDER:
        raise ValueError("founder_required")
    return FOUNDER


def validate_plan(proposed: dict[str, Any]) -> None:
    required = {
        "schema",
        "action",
        "created_utc",
        "expires_utc",
        "tool_revision",
        "review_sha256",
        "artifact",
        "target_image",
        "tag",
        "docker_host",
        "existing_hosts",
        "drift_disposition",
        "activation",
        "access_or_configuration_changes",
        "new_resources",
        "writes_performed",
    }
    review = proposed["artifact"]
    verify_review(review)
    if (
        set(proposed) != required
        or proposed["schema"] != "paired-production-plan-v1"
        or proposed["action"] not in {"publish", "promote-dark"}
        or not REVISION.fullmatch(proposed["tool_revision"])
        or not HEX.fullmatch(proposed["review_sha256"])
        or proposed["target_image"] != IMAGE_PREFIX + "@" + review["image_digest"]
        or proposed["tag"] != target(review)
        or proposed["activation"] is not False
        or proposed["access_or_configuration_changes"] is not False
        or type(proposed["new_resources"]) is not int
        or proposed["new_resources"] != 0
        or type(proposed["writes_performed"]) is not int
        or proposed["writes_performed"] != 0
    ):
        raise ValueError("closed_image_only_plan_required")
    if proposed["action"] == "publish":
        if (
            proposed["existing_hosts"] != {}
            or proposed["drift_disposition"] != "none"
            or not proposed["docker_host"]
            or "\x00" in proposed["docker_host"]
        ):
            raise ValueError("closed_publication_plan_required")
    elif (
        set(proposed["existing_hosts"]) != set(HOSTS)
        or proposed["docker_host"] != ""
        or proposed["drift_disposition"] != "replace_image_only"
        or any(
            set(item) != {"configuration_sha256", "prior_image"}
            or not HEX.fullmatch(item["configuration_sha256"])
            for item in proposed["existing_hosts"].values()
        )
    ):
        raise ValueError("closed_three_host_plan_required")


def execute(
    operator: Operator,
    proposed: dict[str, Any],
    archive: Path,
    core: Path,
    scribe: Path,
    *,
    actor: str,
    journal: Journal,
) -> dict[str, Any]:
    """No authentication, grants, activation, build, silent reconcile or rollback."""
    if actor != FOUNDER:
        raise ValueError("founder_required")
    if journal.plan_sha != fingerprint(proposed):
        raise ValueError("exact_plan_journal_required")
    validate_plan(proposed)
    review = proposed["artifact"]
    verify_archive(archive, review)
    if verify_sources(operator, review, core, scribe) != proposed["tool_revision"]:
        raise ValueError("tool_source_advanced")
    remote = operator.remote(target(review))
    if remote not in (None, review["image_digest"]):
        raise ValueError("remote_artifact_conflict")
    completed: list[str] = []
    if proposed["action"] == "publish":
        if remote is None:
            docker = ["docker", "--host", proposed["docker_host"]]
            journal.append(
                "intent", {"operation": "docker-load", "image_digest": review["image_digest"]}
            )
            loaded = operator.run([*docker, "image", "load", "--input", str(archive)]) or b""
            ids = re.findall(rb"^Loaded image ID: (sha256:[0-9a-f]{64})\s*$", loaded, re.MULTILINE)
            if len(ids) != 1 or ids[0].decode() not in {
                review["config_digest"],
                review["image_digest"],
            }:
                raise ValueError("loaded_artifact_identity_unqualified")
            loaded_id = ids[0].decode()
            info = operator.json([*docker, "image", "inspect", loaded_id])
            if len(info) != 1 or info[0].get("Id") != loaded_id:
                raise ValueError("loaded_artifact_changed")
            labels = info[0]["Config"].get("Labels", {})
            if (
                labels.get("com.cosmaneura.core-source-revision") != review["core_revision"]
                or labels.get("com.cosmaneura.scribe-source-revision") != review["scribe_revision"]
            ):
                raise ValueError("loaded_artifact_changed")
            journal.append(
                "acknowledged", {"operation": "docker-load", "image_digest": review["image_digest"]}
            )
            # Recheck after load; a competing operator must not overwrite our tag.
            remote = operator.remote(target(review))
            if remote not in (None, review["image_digest"]):
                raise ValueError("remote_artifact_conflict")
            if remote is None:
                if verify_sources(operator, review, core, scribe) != proposed["tool_revision"]:
                    raise ValueError("tool_source_advanced")
                operator.run(
                    [*docker, "image", "tag", loaded_id, f"{REGISTRY}.azurecr.io/" + target(review)]
                )
                journal.append(
                    "intent",
                    {
                        "operation": "registry-push",
                        "image_digest": review["image_digest"],
                        "tag": target(review),
                    },
                )
                operator.run([*docker, "image", "push", f"{REGISTRY}.azurecr.io/" + target(review)])
                journal.append("command_returned", {"operation": "registry-push"})
        observed = operator.remote(target(review))
        if observed != review["image_digest"]:
            safe_observed = (
                observed
                if isinstance(observed, str) and DIGEST.fullmatch(observed)
                else "missing_or_invalid"
            )
            raise ValueError(
                "remote_digest_changed_no_promotion:expected="
                + review["image_digest"]
                + ";observed="
                + safe_observed
            )
        journal.append(
            "acknowledged", {"operation": "registry-publication", "remote_digest": observed}
        )
    elif proposed["action"] == "promote-dark":
        if remote != review["image_digest"] or set(proposed["existing_hosts"]) != set(HOSTS):
            raise ValueError("published_artifact_and_three_hosts_required")
        before = {name: projection(operator.resource(name), name) for name in HOSTS}
        if any(
            fingerprint(before[name]) != proposed["existing_hosts"][name]["configuration_sha256"]
            or before[name]["properties"]["template"]["containers"][0]["image"]
            != proposed["existing_hosts"][name]["prior_image"]
            for name in HOSTS
        ):
            raise ValueError("production_drift_replan_required")
        for name, container in HOSTS.items():
            if verify_sources(operator, review, core, scribe) != proposed["tool_revision"]:
                raise ValueError("source_advanced_stop_after:" + ",".join(completed))
            if fingerprint(projection(operator.resource(name), name)) != fingerprint(before[name]):
                raise ValueError("production_drift_stop_after:" + ",".join(completed))
            journal.append(
                "intent",
                {
                    "operation": "host-image-update",
                    "host": name,
                    "image_digest": review["image_digest"],
                },
            )
            try:
                operator.image(name, container, proposed["target_image"])
            except RuntimeError:
                raise RuntimeError(
                    "production_update_failed_or_unconfirmed:"
                    + name
                    + ";completed:"
                    + ",".join(completed)
                ) from None
            expected = copy.deepcopy(before[name])
            expected["properties"]["template"]["containers"][0]["image"] = proposed["target_image"]
            if projection(operator.resource(name), name) != expected:
                raise ValueError(
                    "production_preservation_failed_stop_after:" + ",".join([*completed, name])
                )
            completed.append(name)
            journal.append(
                "acknowledged",
                {"operation": "host-image-update", "host": name, "configuration_preserved": True},
            )
    else:
        raise ValueError("unsupported_action")
    return {
        "schema": "paired-production-execution-v1",
        "action": proposed["action"],
        "approved_plan_sha256": fingerprint(proposed),
        "founder_self_authorization": actor,
        "image_digest": review["image_digest"],
        "core_revision": review["core_revision"],
        "scribe_revision": review["scribe_revision"],
        "remote_digest_verified": True,
        "hosts_updated": completed,
        "activation": False,
        "operational_canary_passed": False,
    }


def write(path: Path, value: dict[str, Any]) -> None:
    data = json.dumps(value, indent=2, sort_keys=True) + "\n"
    with open(path, "x", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
        output.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", choices=("inspect", "plan-publish", "plan-promote-dark", "execute")
    )
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--review-sha256")
    parser.add_argument("--core-source", type=Path)
    parser.add_argument("--scribe-source", type=Path)
    parser.add_argument("--docker-host", default="")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--approved-plan-sha256")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if (
        not args.output.is_absolute()
        or args.output.parent.resolve() != args.output.parent
        or args.output.exists()
        or args.output.is_symlink()
    ):
        parser.error("output must be a new file in an existing canonical directory")
    operator = Operator()
    if args.action == "execute":
        if (
            not args.plan
            or not args.approved_plan_sha256
            or not args.core_source
            or not args.scribe_source
        ):
            parser.error(
                "execute requires plan, its approved canonical SHA-256 and both source checkouts"
            )
        regular(args.plan)
        proposed = decode(args.plan.read_bytes())
        if sys.stdin.isatty():
            print(f"Founder only. Type {proposed['action'].upper()} {args.approved_plan_sha256}")
            confirmation = input()
        else:
            confirmation = ""
        actor = authorize(
            operator,
            proposed,
            args.approved_plan_sha256,
            interactive=sys.stdin.isatty(),
            confirmation=confirmation,
            now=datetime.now(UTC),
        )
        journal = Journal(proposed)
        try:
            result = execute(
                operator,
                proposed,
                args.archive,
                args.core_source,
                args.scribe_source,
                actor=actor,
                journal=journal,
            )
            journal.append("execution_complete", {"action": proposed["action"]})
        except (ValueError, RuntimeError) as error:
            journal.append("failed_or_unconfirmed", {"failure": str(error)})
            write(
                args.output,
                {
                    "schema": "paired-production-execution-failed-v1",
                    "action": proposed["action"],
                    "approved_plan_sha256": fingerprint(proposed),
                    "image_digest": proposed["artifact"]["image_digest"],
                    "failed_or_unconfirmed": True,
                    "failure": str(error),
                    "activation": False,
                    "requires_founder_state_review": True,
                },
            )
            raise
        finally:
            journal.close()
    else:
        if not args.review or not args.review_sha256:
            parser.error("review and its independently accepted file SHA-256 are required")
        review = document(args.review, args.review_sha256)
        verify_archive(args.archive, review)
        if args.action == "inspect":
            result = {
                "schema": "paired-production-inspection-v1",
                "artifact": review,
                "archive_verified": True,
                "writes_performed": 0,
            }
        else:
            if not args.core_source or not args.scribe_source:
                parser.error("both clean current source checkouts are required")
            result = plan(
                operator,
                args.action[5:],
                review,
                args.review_sha256,
                args.archive,
                args.core_source,
                args.scribe_source,
                args.docker_host,
                datetime.now(UTC),
            )
    write(args.output, result)
    print("Saved safe metadata; canonical SHA-256: " + fingerprint(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, KeyError, TypeError, OSError, tarfile.TarError) as error:
        # Never include command output, configuration or credentials in errors.
        print(
            "Stopped: "
            + (
                str(error)
                if isinstance(error, (ValueError, RuntimeError))
                else type(error).__name__
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
