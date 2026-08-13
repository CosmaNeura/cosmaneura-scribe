from __future__ import annotations

import json
from pathlib import Path

from cosmaneura_scribe.main import app

root = Path(__file__).resolve().parents[1]
target = root / "openapi" / "openapi.json"
target.write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
