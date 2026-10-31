"""Closed v2 visit payloads. Core remains the only patient/reminder writer."""

import re
from datetime import date, datetime
from typing import cast

from .provider_core_transport import (
    core_wire_object as obj,
)
from .provider_core_transport import (
    core_wire_require as require,
)
from .provider_core_transport import (
    core_wire_uuid as uuid,
)

BASE = {"action", "request_nonce"}
EXTRAS = {
    "patients": {"patients", "more_results"},
    "create": {"creation_key", "encounter"},
    "patient_match_candidates": {"patients", "more_results", "identity"},
    "patient_match_save": {"change_key", "encounter", "identity"},
    "private_note_read": {"private_note"},
    "private_note_save": {"change_key", "private_note"},
}


def text(value: object, maximum: int, *, empty: bool = False) -> str:
    require(isinstance(value, str))
    assert isinstance(value, str)
    require((empty or bool(value)) and len(value) <= maximum and "\x00" not in value)
    value.encode("utf-8", errors="strict")
    return value


def ref(value: object, prefix: str) -> str:
    value = text(value, 80)
    require(re.fullmatch(prefix + r"_[0-7][0-9a-hjkmnp-tv-z]{25}", value))
    return value


def birthday(value: object) -> None:
    if value is not None:
        value = text(value, 10)
        require(date.fromisoformat(value).isoformat() == value)


def instant(value: object) -> None:
    parsed = datetime.fromisoformat(text(value, 40).replace("Z", "+00:00"))
    require(parsed.tzinfo is not None and parsed.utcoffset() is not None)


def version(value: object) -> int:
    require(type(value) is int)
    assert isinstance(value, int)
    require(0 <= value <= 2_147_483_647)
    return value


def selection(value: object, *, create: bool) -> dict[str, object]:
    row = obj(value)
    if row.get("kind") == "existing":
        require(set(row) == {"kind", "patient_ref"})
        ref(row["patient_ref"], "patient")
    elif create:
        require(row.get("kind") == "new")
        require(
            {"kind", "name", "date_of_birth"}
            <= set(row)
            <= {"kind", "name", "date_of_birth", "provisional"}
        )
        name = text(row["name"], 200)
        require(name == name.strip())
        birthday(row["date_of_birth"])
        require(type(row.get("provisional", False)) is bool)
    else:
        require(set(row) == {"kind", "date_of_birth"} and row.get("kind") == "confirm_new")
        birthday(row["date_of_birth"])
    return row


def request(payload: dict[str, object], key: str) -> str:
    action = text(payload.get("action"), 40)
    require(action in EXTRAS)
    uuid(payload.get("request_nonce"))
    if action == "patients":
        require(BASE <= set(payload) <= BASE | {"query"})
        text(payload.get("query", ""), 200, empty=True)
    elif action == "create":
        require(set(payload) == BASE | {"creation_key", "patient", "appointment_at", "title"})
        require(uuid(payload["creation_key"]) == key)
        selection(payload["patient"], create=True)
        instant(payload["appointment_at"])
        text(payload["title"], 200)
    else:
        action_fields: dict[str, set[str]] = {
            "patient_match_candidates": {"query", "date_of_birth"},
            "patient_match_save": {"selection", "expected_version", "change_key"},
            "private_note_read": set(),
            "private_note_save": {"text", "expected_version", "change_key"},
        }
        extra = action_fields[action]
        require(set(payload) == BASE | {"appointment_ref"} | extra)
        ref(payload["appointment_ref"], "appointment")
        if action == "patient_match_candidates":
            text(payload["query"], 200, empty=True)
            birthday(payload["date_of_birth"])
        elif action != "private_note_read":
            require(uuid(payload["change_key"]) == key)
            version(payload["expected_version"])
            if action == "patient_match_save":
                selection(payload["selection"], create=False)
            else:
                text(payload["text"], 2000, empty=True)
    return action


def identity(value: object) -> dict[str, object]:
    row = obj(value)
    require(set(row) == {"state", "version", "canonical_patient_ref", "name", "date_of_birth"})
    require(row["state"] in {"provisional", "matched", "confirmed"})
    version(row["version"])
    ref(row["canonical_patient_ref"], "patient")
    text(row["name"], 200)
    birthday(row["date_of_birth"])
    return row


def encounter(value: object) -> dict[str, object]:
    row = obj(value)
    fields = {
        "workspace_id",
        "appointment_ref",
        "patient_ref",
        "patient_name",
        "date_of_birth",
        "title",
        "appointment_at",
        "identity",
    }
    require(fields <= set(row) <= fields | {"status"})
    uuid(row["workspace_id"])
    ref(row["appointment_ref"], "appointment")
    ref(row["patient_ref"], "patient")
    text(row["patient_name"], 200)
    text(row["title"], 200)
    birthday(row["date_of_birth"])
    instant(row["appointment_at"])
    identity(row["identity"])
    if "status" in row:
        require(
            row["status"] in {"draft_ready", "processing", "paused", "ready", "recording_saved"}
        )
    return row


def response(value: dict[str, object], payload: dict[str, object], key: str) -> None:
    action = str(payload["action"])
    if action in {"patients", "patient_match_candidates"}:
        require(isinstance(value["patients"], list))
        rows = cast(list[object], value["patients"])
        require(len(rows) <= 100 and type(value["more_results"]) is bool)
        refs: set[str] = set()
        for raw in rows:
            row = obj(raw)
            require(set(row) == {"patient_ref", "name", "date_of_birth"})
            patient = ref(row["patient_ref"], "patient")
            require(patient not in refs)
            refs.add(patient)
            text(row["name"], 200)
            birthday(row["date_of_birth"])
        if action == "patient_match_candidates":
            identity(value["identity"])
    elif action == "create":
        require(value["creation_key"] == key)
        row = encounter(value["encounter"])
        patient = obj(payload["patient"])
        current = identity(row["identity"])
        if patient["kind"] == "existing":
            require(row["patient_ref"] == patient["patient_ref"])
        else:
            require(
                row["patient_name"] == patient["name"]
                and (
                    patient["date_of_birth"] is None
                    or row["date_of_birth"] == patient["date_of_birth"]
                )
            )
            # Core replays the original creation receipt with current visit
            # identity. Later explicit matching must not strand an uncertain
            # creation key on its original device.
            if current["version"] == 0:
                require(
                    current["canonical_patient_ref"] == row["patient_ref"]
                    and current["name"] == patient["name"]
                    and current["state"]
                    == ("provisional" if patient.get("provisional") else "confirmed")
                )
            else:
                require(current["state"] in {"matched", "confirmed"})
                if current["state"] == "confirmed":
                    require(
                        current["canonical_patient_ref"] == row["patient_ref"]
                        and current["name"] == patient["name"]
                    )
    elif action == "patient_match_save":
        require(value["change_key"] == key)
        row = encounter(value["encounter"])
        current = identity(value["identity"])
        chosen = obj(payload["selection"])
        require(
            row["appointment_ref"] == payload["appointment_ref"]
            and row["identity"] == current
            and version(current["version"]) >= version(payload["expected_version"]) + 1
        )
        if chosen["kind"] == "existing":
            require(
                current["state"] == "matched"
                and current["canonical_patient_ref"] == chosen["patient_ref"]
            )
        else:
            require(
                current["state"] == "confirmed"
                and current["canonical_patient_ref"] == row["patient_ref"]
                and (
                    chosen["date_of_birth"] is None
                    or current["date_of_birth"] == chosen["date_of_birth"]
                )
            )
    else:
        note = obj(value["private_note"])
        require(set(note) == {"text", "version", "updated_at"})
        text(note["text"], 2000, empty=True)
        version(note["version"])
        if note["updated_at"] is not None:
            instant(note["updated_at"])
        if action == "private_note_save":
            require(
                value["change_key"] == key
                and note["text"] == payload["text"]
                and version(note["version"]) >= version(payload["expected_version"]) + 1
            )
