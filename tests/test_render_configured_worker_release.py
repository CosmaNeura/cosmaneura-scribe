"""Pure renderer checks; synthetic bindings, no clients or cloud operations."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import UUID

SCRIPT = Path(__file__).parents[1] / "scripts/render_configured_worker_release.py"
SPEC = importlib.util.spec_from_file_location("worker_renderer", SCRIPT)
assert SPEC and SPEC.loader
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)


def bindings(tenant="11111111-aaaa-4111-8111-111111111111"):
    root = (
        "/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13"
        "/resourceGroups/cosmaneura-staging/providers/"
    )

    def worker(index):
        return {
            "client_id": f"00000000-0000-4000-8000-{index:012d}",
            "object_id": f"00000000-0000-4000-8000-{index + 10:012d}",
            "principal_name": f"synthetic_worker_{index}",
            "identity_resource_id": root
            + f"Microsoft.ManagedIdentity/userAssignedIdentities/synthetic-worker-{index}",
            "private_host_cidr": f"10.0.0.{index}/32",
            "key_id": f"https://syntheticvault.vault.azure.net/keys/worker-{index}",
        }

    speech = worker(1)
    speech.update(
        endpoint="https://syntheticspeech.cognitiveservices.azure.com",
        storage_url="https://syntheticstore.blob.core.windows.net",
        container="synthetic-capture",
    )
    translation = worker(2)
    translation.update(
        endpoint="https://synthetictranslation.openai.azure.com/openai/v1",
        deployment="synthetic-model",
    )
    return {
        "schema": 1,
        "environment_id": root
        + "Microsoft.App/managedEnvironments/cosmaneura-staging-scribe-workers-environment",
        "environment_name": "cosmaneura-staging-scribe-workers-environment",
        "location": "northcentralus",
        "image": "syntheticregistry.azurecr.io/scribe/api@sha256:" + "a" * 64,
        "tenant_id": tenant,
        "database_host": "synthetic-db.postgres.database.azure.com",
        "database_name": "synthetic_scribe",
        "speech": speech,
        "translation": translation,
    }


GOLDEN = {
    "11111111-aaaa-4111-8111-111111111111": {
        "speech": "2e18ad18c9a4894f4c3b1480ef00475f1cb2b9d582a784e534a653aaeebd13d6",
        "translation": "3dae18397199e3a9b70eff890a7b57c45b07f74d3471750746e6c7839520750c",
    },
    "11111111AAAA41118111111111111111": {
        "speech": "57e13c8773685a612ec160afc006fb841dc3140356fefd23c4cde753f7b60dbf",
        "translation": "1d15b1d74b05d2010577274dfddd82dab1964d7853a86fc5e67326be36950319",
    },
}


def cohort(count=2):
    data = bindings()
    data.pop("tenant_id")
    data.update(
        schema=2,
        configured_capture_multi_tenant_enabled=True,
        tenant_ids=[str(UUID(int=index + 1)) for index in range(count)],
    )
    return data


class RendererChecks(unittest.TestCase):
    def checked(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bindings.json"
            path.write_text(json.dumps(data))
            return renderer.checked_bindings(path)

    def cli(self, raw):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bindings.json"
            output = Path(directory) / "out"
            path.write_text(raw)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--bindings", str(path), "--output", str(output)],
                capture_output=True,
                text=True,
            )
            jobs = (
                {p.name: p.read_bytes() for p in output.glob("*.job.json")}
                if output.exists()
                else {}
            )
            return result, output.exists(), jobs

    def test_whole_cli_singleton_bytes_match_merged_baseline_for_both_uuid_spellings(self):
        for tenant, expected in GOLDEN.items():
            with self.subTest(tenant=tenant):
                result, exists, jobs = self.cli(json.dumps(bindings(tenant)))
                self.assertEqual(result.returncode, 0)
                self.assertTrue(exists)
                self.assertEqual(result.stdout, "")
                self.assertEqual(set(jobs), {"speech.job.json", "translation.job.json"})
                for phase, digest in expected.items():
                    self.assertEqual(hashlib.sha256(jobs[phase + ".job.json"]).hexdigest(), digest)

    def test_new_mode_changes_only_exact_list_flag_and_arguments_on_both_jobs(self):
        data = self.checked(cohort())
        original = self.checked(bindings())
        for phase in ("speech", "translation"):
            expected = renderer.definition(original, phase)
            container = expected["properties"]["template"]["containers"][0]
            env = {row["name"]: row["value"] for row in container["env"]}
            env["COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS"] = json.dumps(data["tenant_ids"])
            env["COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_MULTI_TENANT_ENABLED"] = "true"
            container["env"] = [{"name": key, "value": value} for key, value in sorted(env.items())]
            container["args"] = ["--cohort-pending"]
            self.assertEqual(renderer.definition(data, phase), expected)

    def test_cli_renders_same_exact_input_order_and_disabled_boundaries(self):
        data = cohort(3)
        data["tenant_ids"].reverse()
        result, exists, jobs = self.cli(json.dumps(data))
        self.assertEqual(result.returncode, 0)
        self.assertTrue(exists)
        for raw in jobs.values():
            job = json.loads(raw)
            container = job["properties"]["template"]["containers"][0]
            env = {row["name"]: row["value"] for row in container["env"]}
            self.assertEqual(
                json.loads(env["COSMANEURA_SCRIBE_CONFIGURED_CAPTURE_TENANT_IDS"]),
                data["tenant_ids"],
            )
            self.assertEqual(env["AZURE_TOKEN_CREDENTIALS"], "ManagedIdentityCredential")
            self.assertEqual(container["args"], ["--cohort-pending"])
            self.assertEqual(
                container["command"],
                ["python", "-m", "cosmaneura_scribe.captured_worker_job_runner"],
            )
            for key in (
                "CAPTURED_WORKER_ENABLED",
                "TRANSCRIPTION_JOB_ENABLED",
                "CONFIGURED_CAPTURE_ENABLED",
                "EXTERNAL_INGEST_ADMISSION_ENABLED",
            ):
                self.assertEqual(env["COSMANEURA_SCRIBE_" + key], "false")
            self.assertFalse(any("OBSERVATION" in key for key in env))

    def test_boundaries_one_and_thirtytwo_remain_valid(self):
        for count in (1, 32):
            data = self.checked(cohort(count))
            self.assertEqual(len(data["tenant_ids"]), count)
            for phase in ("speech", "translation"):
                renderer.definition(data, phase)

    def test_empty_overlimit_nil_duplicate_and_noncanonical_list_refuse(self):
        valid = cohort()["tenant_ids"][0]
        invalid = [
            [],
            cohort(33)["tenant_ids"],
            [str(UUID(int=0))],
            [valid, valid],
            [valid.replace("-", "")],
            ["11111111-AAAA-4111-8111-111111111111"],
            ["urn:uuid:" + valid],
            ["{" + valid + "}"],
            [" " + valid],
            ["invalid"],
            [None],
            [True],
            [1],
            [[valid]],
        ]
        for tenants in invalid:
            with self.subTest(tenants=tenants):
                data = cohort()
                data["tenant_ids"] = tenants
                with self.assertRaises((TypeError, ValueError)):
                    self.checked(data)
        for tenants in (None, {}, "not-a-list", True):
            data = cohort()
            data["tenant_ids"] = tenants
            with self.assertRaises((TypeError, ValueError)):
                self.checked(data)

    def test_explicit_schema_and_true_opt_in_are_required(self):
        for schema in (True, False, 2.0, "2", None, 0, 3):
            data = cohort()
            data["schema"] = schema
            with self.assertRaises(ValueError):
                self.checked(data)
        for value in (False, "true", "false", 1, None):
            data = cohort()
            data["configured_capture_multi_tenant_enabled"] = value
            with self.assertRaises(ValueError):
                self.checked(data)
        data = cohort()
        data.pop("configured_capture_multi_tenant_enabled")
        with self.assertRaises(ValueError):
            self.checked(data)

    def test_unknown_and_mixed_top_or_nested_shapes_refuse(self):
        mutations = [
            lambda d: d.update(tenant_id=bindings()["tenant_id"]),
            lambda d: d.update(unknown="synthetic-private-marker"),
            lambda d: d["speech"].update(unknown="synthetic-private-marker"),
            lambda d: d["translation"].update(storage_url="synthetic-private-marker"),
        ]
        for mutate in mutations:
            data = cohort()
            mutate(data)
            with self.assertRaises(ValueError):
                self.checked(data)
        for extra in (
            {"tenant_ids": cohort()["tenant_ids"]},
            {"configured_capture_multi_tenant_enabled": True},
            {"unknown": "fixture"},
        ):
            data = bindings()
            data.update(extra)
            with self.assertRaises(ValueError):
                self.checked(data)

    def test_duplicate_keys_invalid_shapes_refuse_cli_before_output_mkdir_without_values(self):
        raw = json.dumps(cohort())
        cases = [
            raw.replace('"schema": 2', '"schema": 1, "schema": 2'),
            raw.replace('"client_id":', '"client_id": "synthetic-private-marker", "client_id":', 1),
            json.dumps({**cohort(), "tenant_id": "synthetic-private-marker"}),
            json.dumps({**cohort(), "unknown": "synthetic-private-marker"}),
            json.dumps({**cohort(), "schema": True}),
            "[]",
            "null",
            "{malformed}",
        ]
        for value in cases:
            result, exists, jobs = self.cli(value)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(exists)
            self.assertEqual(jobs, {})
            self.assertEqual(result.stdout, "")
            self.assertEqual(
                result.stderr.strip(), "Reviewed staging worker bindings are incomplete or invalid."
            )
            self.assertNotIn("synthetic-private-marker", result.stderr)

    def test_existing_identity_environment_and_role_refusals_remain(self):
        mutations = [
            lambda d: d.update(environment_id="/foreign/environment"),
            lambda d: d["translation"].update(client_id=d["speech"]["client_id"]),
            lambda d: d["translation"].update(object_id=d["speech"]["object_id"]),
            lambda d: d["translation"].update(principal_name=d["speech"]["principal_name"]),
            lambda d: d["translation"].update(
                identity_resource_id=d["speech"]["identity_resource_id"]
            ),
            lambda d: d["speech"].update(private_host_cidr="127.0.0.1/32"),
        ]
        for mode in (bindings, cohort):
            for mutate in mutations:
                data = mode()
                mutate(data)
                with self.assertRaises(ValueError):
                    self.checked(data)

    def test_input_is_not_rewritten_or_registered(self):
        data = cohort()
        before = copy.deepcopy(data)
        for phase in ("speech", "translation"):
            renderer.definition(data, phase)
        self.assertEqual(data, before)


if __name__ == "__main__":
    unittest.main()
