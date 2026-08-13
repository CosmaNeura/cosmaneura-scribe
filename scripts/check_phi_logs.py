from __future__ import annotations

import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
patterns = [
    re.compile(value, re.IGNORECASE)
    for value in [r"log\.[^(]+\([^\n]*(content|transcript|audio_url|blob_url|patient_name|dob)"]
]
violations: list[str] = []
for path in (root / "services").rglob("*.py"):
    text = path.read_text(encoding="utf-8")
    if any(pattern.search(text) for pattern in patterns):
        violations.append(str(path.relative_to(root)))
if violations:
    raise SystemExit("Potential PHI logging in: " + ", ".join(violations))
