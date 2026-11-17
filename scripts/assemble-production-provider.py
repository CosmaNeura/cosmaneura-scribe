# Founder only. Not for agents. Not the default.
"""Deliberate production assembly; existing native/profile receipt checks still apply."""

import importlib.util
from pathlib import Path

if __name__ == "__main__":
    spec = importlib.util.spec_from_file_location(
        "standalone_provider_assembler", Path(__file__).with_name("assemble-standalone-provider.py")
    )
    assert spec is not None and spec.loader is not None
    assembler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assembler)
    assembler.main(production_entry=True)
