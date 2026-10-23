"""Inert response-contract checks; no database, auth, HTTP, audio or app data.

The standalone receiver's qualified identity package is a deployment input,
not an installable repository dependency. Load its actual class definitions
without imports and replace only the external transport/registry collaborators.
These checks exercise both response paths, not the authorization boundary.
"""

from __future__ import annotations

import ast
import copy
import re
import unittest
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4, uuid5


def receiver_definitions():
    source = Path(__file__).with_name("receiver.py")
    tree = ast.parse(source.read_text())
    names = {"ProviderReceiver", "InvalidRequest", "_require", "_uuid"}
    tree.body = [
        ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
        *(node for node in tree.body if getattr(node, "name", None) in names),
    ]
    scope = {"re": re, "UUID": UUID, "uuid4": uuid4, "uuid5": uuid5}
    exec(compile(ast.fix_missing_locations(tree), str(source), "exec"), scope)
    return scope


@dataclass(frozen=True)
class Selection:
    recovery_scope: UUID
    authorization_revision: UUID
    workspace_id: UUID
    appointment_ref: str
    actor_ref: str
    tenant_ref: str


@dataclass(frozen=True)
class Authorized:
    selection: Selection
    user_token: object


class ReceiverDisplayTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.scope = receiver_definitions()
        self.receiver = object.__new__(self.scope["ProviderReceiver"])
        self.receiver.enabled = self.receiver.encounter_creation_enabled = True
        self.receiver._preparation_handoff = None
        self.receiver.core_http = self.receiver.core_connections = None
        self.receiver.workload_token = object()
        self.receiver.profile = SimpleNamespace(core_origin="https://core.synthetic.invalid")
        self.workspace, self.revision = uuid4(), uuid4()
        self.account = SimpleNamespace(
            recovery_scope=uuid4(), actor_ref="owned-provider", tenant_ref="owned-tenant",
            user_token=object(),
        )
        self.row = {
            "workspace_id": str(self.workspace),
            "appointment_ref": "appointment_01j" + "0" * 23,
            "patient_name": "Synthetic entered name",
            "title": "Fictional follow-up",
            "appointment_at": "2026-10-23T12:00:00Z",
        }
        self.original_patient = "patient_01j" + "0" * 23
        self.matched_patient = "patient_01j" + "0" * 22 + "1"
        self.scope.update(
            AuthorizedCoreProvider=Authorized, CoreProviderSelection=Selection,
            provider_diagnostic_timing=lambda _name: nullcontext(),
        )

    def with_identity(self, state):
        self.row.update(
            patient_ref=self.original_patient, date_of_birth=None, status="draft_ready",
            identity={
                "state": state, "version": 0 if state == "provisional" else 1,
                "canonical_patient_ref": (
                    self.original_patient if state == "provisional" else self.matched_patient
                ),
                "name": "Synthetic chart name", "date_of_birth": "1980-01-02",
                "unsupported_private_metadata": "must not be forwarded",
            },
        )

    async def mounted(self):
        owner = self

        class Transport:
            def __init__(self, *_args, **_kwargs):
                pass

            async def request(self, action, body, key, **_kwargs):
                owner.assertEqual(action, "mount")
                return owner.account, {
                    "encounter": copy.deepcopy(owner.row),
                    "appointment_ref": owner.row["appointment_ref"], "binding_ref": "fixed-binding",
                }

            async def close(self):
                pass

        self.scope["ProviderNativeCoreTransport"] = Transport
        return await self.receiver.native_core_read(
            "unused-owned-auth", self.revision, "mount", {"workspace_id": str(self.workspace)},
            str(uuid4()),
        )

    async def fallback(self):
        reads = []

        async def registry_read(_operation):
            reads.append(True)
            return False if len(reads) == 1 else self.account

        async def encounters(authorization, body, _key):
            self.assertEqual(authorization, "unused-owned-auth")
            self.assertEqual(body["workspace_id"], str(self.workspace))
            return {"encounter": copy.deepcopy(self.row)}

        self.receiver.registry_read = registry_read
        self.receiver.encounters = encounters
        authorized, display = await self.receiver.selected_current(
            "unused-owned-auth", self.revision, self.workspace,
        )
        self.assertEqual(len(reads), 3)
        self.assertEqual(authorized.selection.workspace_id, self.workspace)
        self.assertEqual(authorized.selection.recovery_scope, self.account.recovery_scope)
        self.assertIs(authorized.user_token, self.account.user_token)
        return display

    async def test_provisional_to_matched_identity_survives_mount_and_fallback(self):
        for state in ("provisional", "matched", "confirmed"):
            with self.subTest(state=state):
                self.with_identity(state)
                mount = await self.mounted()
                display = await self.fallback()
                for response in (mount["encounter"], display):
                    self.assertEqual(response["patientRef"], self.original_patient)
                    self.assertIsNone(response["dateOfBirth"])
                    self.assertEqual(response["status"], "draft_ready")
                    self.assertEqual(response["identity"]["state"], state)
                    self.assertEqual(response["identity"]["canonical_patient_ref"],
                                     self.row["identity"]["canonical_patient_ref"])
                    self.assertEqual(response["identity"]["date_of_birth"], "1980-01-02")
                    self.assertNotIn("unsupported_private_metadata", response["identity"])
                self.assertEqual(mount["workspaceId"], str(self.workspace))
                self.assertEqual(mount["recoveryScope"], str(self.account.recovery_scope))
                self.assertTrue(mount["encounter"]["native_recording_preparation_v1"])

    async def test_older_core_response_does_not_invent_identity(self):
        for response in ((await self.mounted())["encounter"], await self.fallback()):
            for optional in ("identity", "patientRef", "dateOfBirth", "status"):
                self.assertNotIn(optional, response)
            self.assertEqual(response["patientName"], self.row["patient_name"])

    async def test_invalid_optional_evidence_is_not_published(self):
        changes = (
            {"patient_ref": "not-a-patient-reference"}, {"date_of_birth": "unknown"},
            {"status": "invented-status"}, {"identity": {"state": "invented"}},
        )
        for change in changes:
            with self.subTest(field=next(iter(change))):
                original = copy.deepcopy(self.row)
                self.row.update(change)
                with self.assertRaises(self.scope["InvalidRequest"]):
                    await self.mounted()
                with self.assertRaises(self.scope["InvalidRequest"]):
                    await self.fallback()
                self.row = original

    async def test_identity_requires_verified_contract_fields(self):
        self.with_identity("matched")
        for change in (
            {"version": True}, {"version": -1}, {"version": 9_007_199_254_740_992},
            {"canonical_patient_ref": "unverified-patient"}, {"name": ""},
            {"date_of_birth": "unknown"},
        ):
            with self.subTest(field=next(iter(change)), value=next(iter(change.values()))):
                original = copy.deepcopy(self.row["identity"])
                self.row["identity"].update(change)
                with self.assertRaises(self.scope["InvalidRequest"]):
                    await self.mounted()
                with self.assertRaises(self.scope["InvalidRequest"]):
                    await self.fallback()
                self.row["identity"] = original

    async def test_display_cannot_replace_selected_workspace(self):
        self.with_identity("matched")
        self.row["workspace_id"] = str(uuid4())
        with self.assertRaises(self.scope["InvalidRequest"]):
            await self.mounted()
        with self.assertRaises(self.scope["InvalidRequest"]):
            await self.fallback()


if __name__ == "__main__":
    unittest.main()
