"""Offline publishing boundaries; every cloud/tool mutation below is a fake."""

from __future__ import annotations

import copy
import io
import json
import os
import signal
import subprocess
import sys
import tarfile
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from tools.production import paired_image_release as release

NOW = datetime(2026, 10, 31, 12, tzinfo=UTC)
CORE, SCRIBE = "1" * 40, "2" * 40


def fixture(
    folder: Path,
    *,
    labels: dict[str, str] | None = None,
    extra: str | None = None,
    multi: bool = False,
) -> tuple[Path, dict]:
    layers = [b"base layer", b"paired overlay"]
    config = {
        "architecture": "amd64",
        "os": "linux",
        "rootfs": {"diff_ids": ["sha256:" + release.digest(value) for value in layers]},
        "config": {
            "User": "0:0",
            "Cmd": ["celery worker"],
            "Entrypoint": ["/bin/bash", "-c"],
            "Env": ["PATH=/usr/bin"],
            "WorkingDir": "/app",
            "Labels": labels
            or {
                "com.cosmaneura.core-source-revision": CORE,
                "com.cosmaneura.scribe-source-revision": SCRIBE,
            },
        },
    }
    config_bytes = release.canonical(config)
    config_digest = "sha256:" + release.digest(config_bytes)
    manifest = {
        "schemaVersion": 2,
        "config": {"digest": config_digest, "size": len(config_bytes)},
        "layers": [
            {"digest": "sha256:" + release.digest(value), "size": len(value)} for value in layers
        ],
    }
    manifest_bytes = release.canonical(manifest)
    image_digest = "sha256:" + release.digest(manifest_bytes)
    descriptor = {"digest": image_digest, "size": len(manifest_bytes)}
    content = {
        "oci-layout": release.canonical({"imageLayoutVersion": "1.0.0"}),
        "index.json": release.canonical(
            {"schemaVersion": 2, "manifests": [descriptor] * (2 if multi else 1)}
        ),
        "manifest.json": release.canonical(
            [
                {
                    "Config": "blobs/sha256/" + config_digest[7:],
                    "RepoTags": None,
                    "Layers": ["blobs/sha256/" + item["digest"][7:] for item in manifest["layers"]],
                }
            ]
        ),
        "blobs/sha256/" + config_digest[7:]: config_bytes,
        "blobs/sha256/" + image_digest[7:]: manifest_bytes,
        **{"blobs/sha256/" + release.digest(value): value for value in layers},
    }
    archive = folder / "paired-image.tar"
    with tarfile.open(archive, "w") as bundle:
        for name, data in content.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            bundle.addfile(info, io.BytesIO(data))
        if extra:
            info = tarfile.TarInfo(extra)
            info.type, info.linkname = tarfile.SYMTYPE, "/outside"
            bundle.addfile(info)
    runtime = {
        key: config["config"].get(key) for key in ("User", "Env", "Cmd", "Entrypoint", "WorkingDir")
    }
    review = {
        "schema": "paired-production-artifact-v1",
        "core_revision": CORE,
        "core_tree": "3" * 40,
        "scribe_revision": SCRIBE,
        "scribe_tree": "4" * 40,
        "archive_sha256": release.file_hash(archive),
        "archive_bytes": archive.stat().st_size,
        "image_digest": image_digest,
        "config_digest": config_digest,
        "core_base_digest": "sha256:" + "5" * 64,
        "core_base_layers": [manifest["layers"][0]["digest"]],
        "core_runtime_sha256": release.fingerprint(runtime),
        "independent_evidence_sha256": "6" * 64,
        "qualification": {name: True for name in release.QUALIFICATION},
    }
    return archive, review


def resource(name: str) -> dict:
    return {
        "id": f"{release.CORE_ID}/providers/Microsoft.App/containerApps/{name}",
        "name": name,
        "location": "eastus",
        "identity": {"type": "None"},
        "tags": {"owned": "yes"},
        "properties": {
            "provisioningState": "Succeeded",
            "latestRevisionName": "computed",
            "environmentId": "existing-environment",
            "configuration": {
                "ingress": {"external": name.endswith("app")},
                "secrets": [{"name": "existing"}],
            },
            "template": {
                "containers": [
                    {
                        "name": release.HOSTS[name],
                        "image": release.IMAGE_PREFIX + ":prior",
                        "command": ["existing", name],
                        "args": ["keep"],
                        "env": [
                            {"name": "EXISTING", "value": "private-value-never-in-plan"},
                            {"name": release.FLAGS[0], "value": "false"},
                        ],
                        "resources": {"cpu": 1, "memory": "2Gi"},
                    }
                ],
                "scale": {"minReplicas": 1, "maxReplicas": 2},
            },
        },
    }


class Fake(release.Operator):
    def __init__(self, review: dict):
        self.review = review
        self.remote_digest = review["image_digest"]
        self.heads = {release.CORE_REPO: CORE, release.SCRIBE_REPO: SCRIBE}
        self.resources = {name: resource(name) for name in release.HOSTS}
        self.commands: list[list[str]] = []
        self.updates: list[str] = []
        self.login = release.FOUNDER
        self.corrupt_after_update = False
        self.fail_second = False
        self.convert_push = False
        self.inputs_changed = False

    def current(self, repository: str, branch: str) -> str:
        return self.heads[repository]

    def run(self, args: list[str], **kwargs) -> bytes:
        self.commands.append(args)
        if args[0] == "git":
            core = args[2] == "/core"
            if args[3:] == ["rev-parse", "HEAD"]:
                return self.heads[release.CORE_REPO if core else release.SCRIBE_REPO].encode()
            if args[3] == "rev-parse":
                return self.review["core_tree" if core else "scribe_tree"].encode()
            if args[3] == "diff" and self.inputs_changed:
                raise RuntimeError("changed packaged inputs")
        if args[0] == "docker" and "push" in args:
            self.remote_digest = (
                "sha256:" + "9" * 64 if self.convert_push else self.review["image_digest"]
            )
        if args[0] == "docker" and "load" in args:
            return ("Loaded image ID: " + self.review["image_digest"] + "\n").encode()
        return b""

    def json(self, args: list[str]):
        if args[:3] == ["gh", "api", "user"]:
            return {"login": self.login}
        if args[0] == "az":
            return {"id": release.REGISTRY_ID}
        if args[0] == "docker":
            return [
                {
                    "Id": self.review["image_digest"],
                    "Config": {
                        "Labels": {
                            "com.cosmaneura.core-source-revision": CORE,
                            "com.cosmaneura.scribe-source-revision": SCRIBE,
                        }
                    },
                }
            ]
        raise AssertionError(args)

    def remote(self, image: str) -> str | None:
        return self.remote_digest

    def resource(self, name: str) -> dict:
        return copy.deepcopy(self.resources[name])

    def image(self, name: str, container: str, reference: str) -> None:
        if self.fail_second and len(self.updates) == 1:
            raise RuntimeError("unconfirmed fake update")
        self.updates.append(name)
        self.resources[name]["properties"]["template"]["containers"][0]["image"] = reference
        if self.corrupt_after_update:
            self.resources[name]["properties"]["template"]["containers"][0]["env"] = []


class PublishingBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name).resolve()
        self.archive, self.review = fixture(self.folder)
        self.fake = Fake(self.review)

    def tearDown(self):
        self.temp.cleanup()

    def make_plan(self, action="promote-dark"):
        return release.plan(
            self.fake,
            action,
            self.review,
            "7" * 64,
            self.archive,
            Path("/core"),
            Path("/scribe"),
            "unix:///existing/docker.sock",
            NOW,
        )

    def execute(self, plan):
        journal = release.Journal(plan, root=self.folder / "journal")
        try:
            return release.execute(
                self.fake,
                plan,
                self.archive,
                Path("/core"),
                Path("/scribe"),
                actor=release.FOUNDER,
                journal=journal,
            )
        finally:
            journal.close()

    def test_exact_archive_is_accepted_without_extraction(self):
        release.verify_archive(self.archive, self.review)
        self.assertEqual(list(self.folder.iterdir()), [self.archive])

    def test_offline_inspect_command_writes_private_receipt_without_operator(self):
        review_path = self.folder / "review.json"
        review_path.write_text(json.dumps(self.review))
        output = self.folder / "inspection.json"
        arguments = [
            "paired_image_release",
            "inspect",
            "--archive",
            str(self.archive),
            "--review",
            str(review_path),
            "--review-sha256",
            release.file_hash(review_path),
            "--output",
            str(output),
        ]
        with (
            patch("sys.argv", arguments),
            patch.object(release.Operator, "run", side_effect=AssertionError("operator called")),
        ):
            release.main()
        self.assertTrue(json.loads(output.read_text())["archive_verified"])
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_changed_archive_is_refused(self):
        with self.archive.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "archive_changed"):
            release.verify_archive(self.archive, self.review)

    def test_qualified_digest_does_not_accept_source_relabel(self):
        self.archive, self.review = fixture(
            self.folder,
            labels={
                "com.cosmaneura.core-source-revision": CORE,
                "com.cosmaneura.scribe-source-revision": "a" * 40,
            },
        )
        with self.assertRaisesRegex(ValueError, "runtime_provenance"):
            release.verify_archive(self.archive, self.review)

    def test_archive_symlink_is_refused(self):
        self.archive, self.review = fixture(self.folder, extra="../../escape")
        with self.assertRaisesRegex(ValueError, "members_invalid"):
            release.verify_archive(self.archive, self.review)

    def test_multiple_images_are_refused(self):
        self.archive, self.review = fixture(self.folder, multi=True)
        with self.assertRaisesRegex(ValueError, "single_image"):
            release.verify_archive(self.archive, self.review)

    def test_false_qualification_is_refused(self):
        self.review["qualification"]["child_env_i_uid10001_passed"] = False
        with self.assertRaisesRegex(ValueError, "qualification"):
            release.verify_archive(self.archive, self.review)

    def test_core_advance_requires_new_pair(self):
        self.fake.heads[release.CORE_REPO] = "a" * 40
        with self.assertRaisesRegex(ValueError, "core_advanced"):
            self.make_plan()

    def test_later_tool_commit_does_not_relabel_original_scribe(self):
        self.fake.heads[release.SCRIBE_REPO] = "b" * 40
        proposed = self.make_plan()
        self.assertEqual(proposed["artifact"]["scribe_revision"], SCRIBE)
        self.assertEqual(proposed["tool_revision"], "b" * 40)

    def test_changed_scribe_packaged_input_is_refused(self):
        self.fake.inputs_changed = True
        with self.assertRaises(RuntimeError):
            self.make_plan()

    def test_publication_tag_fits_docker_limit(self):
        self.assertLessEqual(len(release.target(self.review).split(":")[1]), 128)

    def test_conflicting_remote_artifact_is_refused_before_write(self):
        self.fake.remote_digest = "sha256:" + "a" * 64
        with self.assertRaisesRegex(ValueError, "conflicting"):
            self.make_plan("publish")
        self.assertEqual(self.fake.updates, [])

    def test_plan_contains_hashes_not_environment_values(self):
        proposed = self.make_plan()
        self.assertNotIn("private-value-never-in-plan", json.dumps(proposed))
        self.assertEqual(len(proposed["existing_hosts"]), 3)

    def test_active_or_secret_backed_bundle_flag_is_refused(self):
        name = next(iter(release.HOSTS))
        env = self.fake.resources[name]["properties"]["template"]["containers"][0]["env"]
        for item in (
            {"name": release.FLAGS[0], "value": "true"},
            {"name": release.FLAGS[0], "secretRef": "unknown"},
        ):
            env[-1] = item
            with self.assertRaisesRegex(ValueError, "bundle"):
                self.make_plan()

    def test_founder_noninteractive_and_expired_plan_are_refused(self):
        proposed = self.make_plan()
        expected = release.fingerprint(proposed)
        for interactive, login, time in (
            (False, release.FOUNDER, NOW),
            (True, "someone-else", NOW),
            (True, release.FOUNDER, NOW + timedelta(hours=1)),
        ):
            self.fake.login = login
            with self.assertRaises(ValueError):
                release.authorize(
                    self.fake,
                    proposed,
                    expected,
                    interactive=interactive,
                    confirmation="PROMOTE-DARK " + expected,
                    now=time,
                )

    def test_approved_plan_cannot_widen_target_or_activation(self):
        for field, value in (("activation", True), ("target_image", "other-registry/image:latest")):
            proposed = self.make_plan()
            proposed[field] = value
            with self.assertRaisesRegex(ValueError, "closed_image_only"):
                self.execute(proposed)
        self.assertEqual(self.fake.updates, [])

    def test_existing_published_digest_is_verified_noop(self):
        receipt = self.execute(self.make_plan("publish"))
        self.assertTrue(receipt["remote_digest_verified"])
        self.assertFalse(any(args[0] == "docker" and "push" in args for args in self.fake.commands))

    def test_publish_uses_original_artifact_not_a_build(self):
        self.fake.remote_digest = None
        self.execute(self.make_plan("publish"))
        commands = self.fake.commands
        self.assertTrue(any("load" in args and str(self.archive) in args for args in commands))
        self.assertTrue(any("push" in args for args in commands))
        self.assertFalse(any("build" in args for args in commands))
        self.assertEqual(self.fake.updates, [])

    def test_docker_manifest_conversion_stops_before_promotion(self):
        self.fake.remote_digest = None
        self.fake.convert_push = True
        with self.assertRaisesRegex(ValueError, "remote_digest_changed"):
            self.execute(self.make_plan("publish"))
        self.assertEqual(self.fake.updates, [])

    def test_production_configuration_drift_stops_before_first_write(self):
        proposed = self.make_plan()
        name = next(iter(release.HOSTS))
        self.fake.resources[name]["properties"]["template"]["scale"]["minReplicas"] = 2
        with self.assertRaisesRegex(ValueError, "production_drift"):
            self.execute(proposed)
        self.assertEqual(self.fake.updates, [])

    def test_three_host_promotion_preserves_commands_env_and_configuration(self):
        proposed = self.make_plan()
        before = copy.deepcopy(self.fake.resources)
        receipt = self.execute(proposed)
        for name in release.HOSTS:
            before[name]["properties"]["template"]["containers"][0]["image"] = proposed[
                "target_image"
            ]
        self.assertEqual(self.fake.resources, before)
        self.assertEqual(len(receipt["hosts_updated"]), 3)
        self.assertFalse(receipt["activation"])

    def test_failed_preservation_stops_without_automatic_rollback(self):
        proposed = self.make_plan()
        self.fake.corrupt_after_update = True
        with self.assertRaisesRegex(ValueError, "preservation_failed"):
            self.execute(proposed)
        self.assertEqual(len(self.fake.updates), 1)

    def test_partial_three_host_failure_is_reported_and_stops(self):
        proposed = self.make_plan()
        self.fake.fail_second = True
        with self.assertRaisesRegex(
            RuntimeError, "failed_or_unconfirmed.*completed:cosmaneura-prod-app"
        ):
            self.execute(proposed)
        self.assertEqual(self.fake.updates, ["cosmaneura-prod-app"])

    def test_authentication_failure_is_not_registry_absence(self):
        class Denied:
            returncode = 1

            def communicate(self, timeout):
                return b"", b"UNAUTHORIZED"

        with patch("subprocess.Popen", return_value=Denied()), self.assertRaises(RuntimeError):
            release.Operator().remote("repo:tag")

    def test_owned_command_timeout_terminates_group_and_reaps_without_retry(self):
        spawned = []
        original = subprocess.Popen

        def start(args, **kwargs):
            process = original(args, **kwargs)
            spawned.append(process)
            return process

        operator = release.Operator()
        with (
            patch.object(operator, "timeout", return_value=0.05),
            patch("subprocess.Popen", side_effect=start) as launch,
            patch("os.killpg", wraps=os.killpg) as terminate,
        ):
            with self.assertRaisesRegex(RuntimeError, "timeout_unconfirmed"):
                operator.run([sys.executable, "-c", "import time; time.sleep(30)"])
        self.assertEqual(launch.call_count, 1)
        self.assertTrue(launch.call_args.kwargs["start_new_session"])
        terminate.assert_called_with(spawned[0].pid, signal.SIGTERM)
        self.assertIsNotNone(spawned[0].poll())

    def test_journal_blocks_same_plan_replay_before_another_mutation(self):
        proposed = self.make_plan()
        self.execute(proposed)
        before = list(self.fake.updates)
        with self.assertRaisesRegex(ValueError, "already_attempted"):
            self.execute(proposed)
        self.assertEqual(self.fake.updates, before)

    def test_owned_process_interruption_cleans_group_before_propagating(self):
        spawned = []
        original = subprocess.Popen

        def start(args, **kwargs):
            process = original(args, **kwargs)
            spawned.append(process)
            communicate = process.communicate

            def interrupted(timeout):
                process.communicate = communicate
                raise KeyboardInterrupt

            process.communicate = interrupted
            return process

        with (
            patch("subprocess.Popen", side_effect=start) as launch,
            patch("os.killpg", wraps=os.killpg) as terminate,
            self.assertRaises(KeyboardInterrupt),
        ):
            release.Operator().run([sys.executable, "-c", "import time; time.sleep(30)"])
        self.assertEqual(launch.call_count, 1)
        terminate.assert_called_with(spawned[0].pid, signal.SIGTERM)
        self.assertIsNotNone(spawned[0].poll())

    def test_interrupted_publication_retains_intent_and_blocks_replay(self):
        self.fake.remote_digest = None
        proposed = self.make_plan("publish")
        original = self.fake.run

        def interrupt(args, **kwargs):
            if "push" in args:
                raise KeyboardInterrupt
            return original(args, **kwargs)

        with (
            patch.object(self.fake, "run", side_effect=interrupt),
            self.assertRaises(KeyboardInterrupt),
        ):
            self.execute(proposed)
        path = self.folder / "journal" / (release.fingerprint(proposed) + ".jsonl")
        events = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual(events[-1]["event"], "intent")
        self.assertEqual(events[-1]["operation"], "registry-push")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ValueError, "already_attempted"):
            self.execute(proposed)

    def test_each_host_intent_is_visible_before_the_update(self):
        proposed = self.make_plan()
        original = self.fake.image
        path = self.folder / "journal" / (release.fingerprint(proposed) + ".jsonl")

        def inspect_intent(name, container, reference):
            last = json.loads(path.read_text().splitlines()[-1])
            self.assertEqual(last["event"], "intent")
            self.assertEqual(last["host"], name)
            original(name, container, reference)

        with patch.object(self.fake, "image", side_effect=inspect_intent):
            self.execute(proposed)


if __name__ == "__main__":
    unittest.main()
