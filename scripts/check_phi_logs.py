from __future__ import annotations

import argparse
import ast
from pathlib import Path

LOG_METHODS = frozenset({"debug", "info", "warning", "error", "exception", "critical", "log"})


def _safe_helper_aliases(tree: ast.Module) -> tuple[set[str], set[str]]:
    function_aliases: set[str] = set()
    module_aliases: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module is not None:
            if node.module.endswith("safe_logging"):
                for imported in node.names:
                    if imported.name == "log_event":
                        function_aliases.add(imported.asname or imported.name)
        elif isinstance(node, ast.Import):
            for imported in node.names:
                if imported.name.endswith("safe_logging"):
                    module_aliases.add(imported.asname or imported.name)
    return function_aliases, module_aliases


def _is_safe_helper_call(
    function: ast.expr,
    function_aliases: set[str],
    module_aliases: set[str],
) -> bool:
    if isinstance(function, ast.Name):
        return function.id in function_aliases
    if isinstance(function, ast.Attribute) and function.attr == "log_event":
        return isinstance(function.value, ast.Name) and function.value.id in module_aliases
    return False


def _boundary_allowlist(boundary: Path) -> frozenset[str] | None:
    tree = ast.parse(boundary.read_text(encoding="utf-8"), filename=str(boundary))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name) and target.id == "LOG_FIELD_ALLOWLIST"
            for target in node.targets
        ):
            continue
        value = node.value
        if (
            not isinstance(value, ast.Call)
            or not isinstance(value.func, ast.Name)
            or value.func.id != "frozenset"
            or len(value.args) != 1
            or not isinstance(value.args[0], ast.Set)
        ):
            return None
        fields = value.args[0].elts
        if not all(
            isinstance(field, ast.Constant) and isinstance(field.value, str) for field in fields
        ):
            return None
        return frozenset(field.value for field in fields if isinstance(field.value, str))
    return None


def _validate_helper_call(call: ast.Call, allowed_fields: frozenset[str]) -> str | None:
    if call.args:
        return "structured log calls may not use positional arguments"
    keywords = {keyword.arg for keyword in call.keywords}
    if None in keywords:
        return "structured log calls may not use **kwargs"
    unexpected = keywords - allowed_fields
    if unexpected:
        return f"structured log fields are not allow-listed: {sorted(unexpected)}"
    if "action" not in keywords:
        return "structured log calls require action"
    action = next(keyword.value for keyword in call.keywords if keyword.arg == "action")
    if not isinstance(action, ast.Constant) or not isinstance(action.value, str):
        return "structured log action must be a string literal"
    return None


def scan(root: Path) -> list[str]:
    violations: list[str] = []
    services = root / "services"
    boundary = services / "api" / "src" / "cosmaneura_scribe" / "safe_logging.py"
    if not boundary.is_file():
        return ["structured logging boundary is missing"]
    allowed_fields = _boundary_allowlist(boundary)
    if allowed_fields is None:
        return ["structured logging boundary has no static LOG_FIELD_ALLOWLIST"]

    for path in services.rglob("*.py"):
        relative = path.relative_to(root)
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(relative))
        except SyntaxError as exc:
            violations.append(f"{relative}:{exc.lineno}: cannot inspect invalid Python")
            continue
        function_aliases, module_aliases = _safe_helper_aliases(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if path == boundary:
                if (
                    isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "_LOGGER"
                    and node.func.attr == "log"
                ):
                    continue
            if _is_safe_helper_call(node.func, function_aliases, module_aliases):
                violation = _validate_helper_call(node, allowed_fields)
                if violation is not None:
                    violations.append(f"{relative}:{node.lineno}: {violation}")
                continue
            if isinstance(node.func, ast.Attribute) and node.func.attr in LOG_METHODS:
                violations.append(
                    f"{relative}:{node.lineno}: direct logging call bypasses safe_logging.log_event"
                )
            elif isinstance(node.func, ast.Name) and node.func.id == "print":
                violations.append(
                    f"{relative}:{node.lineno}: print bypasses safe_logging.log_event"
                )
    return violations


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    args = parser.parse_args()
    violations = scan(args.root.resolve())
    if violations:
        raise SystemExit("Unsafe application logging:\n" + "\n".join(violations))


if __name__ == "__main__":
    main()
