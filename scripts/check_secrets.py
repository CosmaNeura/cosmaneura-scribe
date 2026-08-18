from __future__ import annotations

import math
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {
    ".git",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    "node_modules",
}
SKIP_FILES = {"uv.lock", "openapi.json"}
PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "OpenAI key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    "Azure connection string": re.compile(r"AccountKey=[A-Za-z0-9+/=]{20,}"),
}
ASSIGNMENT = re.compile(
    r"(?i)(?:api[_-]?key|secret|token|password)\s*[:=]\s*['\"]([^'\"]{20,})['\"]"
)


def entropy(value: str) -> float:
    counts = Counter(value)
    return -sum((count / len(value)) * math.log2(count / len(value)) for count in counts.values())


violations: list[str] = []
for path in ROOT.rglob("*"):
    if not path.is_file() or any(part in SKIP_PARTS for part in path.parts):
        continue
    if path.name in SKIP_FILES or path.stat().st_size > 1_000_000:
        continue
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    relative = path.relative_to(ROOT)
    for label, pattern in PATTERNS.items():
        if pattern.search(content):
            violations.append(f"{relative}: possible {label}")
    for match in ASSIGNMENT.finditer(content):
        candidate = match.group(1)
        if entropy(candidate) >= 3.5 and not candidate.startswith(("${", "<", "your-")):
            violations.append(f"{relative}: possible high-entropy credential")

if violations:
    raise SystemExit("Secret scan failed:\n" + "\n".join(sorted(set(violations))))
