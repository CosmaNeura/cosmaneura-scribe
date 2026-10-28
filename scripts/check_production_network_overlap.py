#!/usr/bin/env python3
"""Fail closed when a proposed production VNet overlaps Azure inventory."""

from __future__ import annotations

import argparse
import ipaddress
import json
from pathlib import Path
from typing import cast

Network = ipaddress.IPv4Network | ipaddress.IPv6Network


def _networks(document: object) -> list[tuple[str, str, Network]]:
    if not isinstance(document, list):
        raise ValueError("inventory_must_be_a_list")

    observed: list[tuple[str, str, Network]] = []
    for raw_entry in cast(list[object], document):
        if not isinstance(raw_entry, dict):
            raise ValueError("inventory_entry_must_be_an_object")
        entry = cast(dict[str, object], raw_entry)
        name = entry.get("name")
        resource_group = entry.get("resourceGroup")
        prefixes = entry.get("prefixes")
        if prefixes is None:
            address_space = entry.get("addressSpace")
            prefixes = (
                cast(dict[str, object], address_space).get("addressPrefixes")
                if isinstance(address_space, dict)
                else None
            )
        if not isinstance(name, str) or not isinstance(resource_group, str):
            raise ValueError("inventory_identity_invalid")
        if not isinstance(prefixes, list) or not prefixes:
            raise ValueError("inventory_prefixes_invalid")
        for prefix in cast(list[object], prefixes):
            if not isinstance(prefix, str):
                raise ValueError("inventory_prefix_invalid")
            observed.append((name, resource_group, ipaddress.ip_network(prefix, strict=True)))
    return observed


def find_overlaps(candidates: list[str], inventory: object) -> list[dict[str, str]]:
    proposed = [ipaddress.ip_network(candidate, strict=True) for candidate in candidates]
    overlaps: list[dict[str, str]] = []
    for candidate in proposed:
        for name, resource_group, existing in _networks(inventory):
            if candidate.version == existing.version and candidate.overlaps(existing):
                overlaps.append(
                    {
                        "candidate": str(candidate),
                        "existing": str(existing),
                        "name": name,
                        "resourceGroup": resource_group,
                    }
                )
    return overlaps


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", action="append", required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    args = parser.parse_args()

    inventory: object = json.loads(args.inventory.read_text(encoding="utf-8"))
    overlaps = find_overlaps(args.candidate, inventory)
    if overlaps:
        print(
            json.dumps(
                {"status": "PRODUCTION_VNET_OVERLAP", "overlaps": overlaps},
                sort_keys=True,
            )
        )
        return 1
    print(
        json.dumps(
            {
                "status": "PRODUCTION_VNET_CIDRS_AVAILABLE_IN_OBSERVED_INVENTORY",
                "candidates": args.candidate,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
