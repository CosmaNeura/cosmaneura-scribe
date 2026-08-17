from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

ADR_FILENAME = re.compile(r"^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")


def find_adr_number_violations(directory: Path) -> list[str]:
    numbers: dict[str, list[str]] = defaultdict(list)
    violations: list[str] = []
    for path in sorted(directory.iterdir(), key=lambda candidate: candidate.name):
        if not path.is_file() or path.suffix.lower() != ".md":
            continue
        match = ADR_FILENAME.fullmatch(path.name)
        if match is None:
            violations.append(f"Malformed ADR filename: {path.name}")
            continue
        numbers[match.group(1)].append(path.name)

    for number, names in sorted(numbers.items()):
        if len(names) > 1:
            violations.append(f"Duplicate ADR number {number}: {', '.join(sorted(names))}")
    return violations


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    violations = find_adr_number_violations(root / "docs" / "adr")
    if violations:
        raise SystemExit("ADR numbering violations:\n" + "\n".join(violations))


if __name__ == "__main__":
    main()
