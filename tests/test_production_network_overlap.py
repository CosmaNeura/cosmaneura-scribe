from __future__ import annotations

import importlib.util
import ipaddress
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_production_network_overlap.py"
PRODUCTION = ROOT / "infra" / "production.tfvars.example"
INVENTORY = ROOT / "tests" / "fixtures" / "infra" / "azure_vnet_inventory_2026-10-28.json"


def _module():
    spec = importlib.util.spec_from_file_location("production_network_overlap", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _production_cidrs() -> dict[str, list[str]]:
    values: dict[str, list[str]] = {}
    for name, literal in re.findall(
        r"^([a-z_]+address_(?:space|prefixes))\s*=\s*(\[[^\n]+\])$",
        PRODUCTION.read_text(encoding="utf-8"),
        flags=re.MULTILINE,
    ):
        values[name] = json.loads(literal)
    return values


def test_previous_production_range_collides_with_observed_subscription() -> None:
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))

    assert _module().find_overlaps(["10.44.0.0/16"], inventory) == [
        {
            "candidate": "10.44.0.0/16",
            "existing": "10.44.0.0/16",
            "name": "cosmaneura-scheduling-dev-vnet",
            "resourceGroup": "cosmaneura-scheduling-development",
        }
    ]


def test_production_example_is_disjoint_from_observed_subscription() -> None:
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    values = _production_cidrs()
    vnet = ipaddress.IPv4Network(values["virtual_network_address_space"][0])

    assert str(vnet) == "10.46.0.0/16"
    assert _module().find_overlaps([str(vnet)], inventory) == []
    for name, prefixes in values.items():
        if name == "virtual_network_address_space":
            continue
        assert all(ipaddress.IPv4Network(prefix).subnet_of(vnet) for prefix in prefixes)


def test_overlap_check_detects_contained_existing_prefix() -> None:
    inventory = [
        {
            "name": "future-vnet",
            "resourceGroup": "future",
            "prefixes": ["10.46.8.0/24"],
        }
    ]

    assert _module().find_overlaps(["10.46.0.0/16"], inventory)[0]["existing"] == ("10.46.8.0/24")
