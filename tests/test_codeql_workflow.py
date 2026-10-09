from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "codeql.yml"


def test_codeql_preserves_supported_languages_and_excludes_false_ruby_detection() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    for language in (
        "actions",
        "java-kotlin",
        "javascript-typescript",
        "python",
    ):
        assert f"          - {language}\n" in workflow
    assert "          languages: swift\n" in workflow
    assert "ruby" not in workflow.lower()


def test_swift_codeql_uses_the_proven_manual_capacitor_build_path() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    swift_job = workflow.split("\n  analyze-swift:\n", maxsplit=1)[1]

    for required in (
        "runs-on: macos-26",
        'node-version: "24.5.0"',
        "npm install --global npm@11.5.2",
        "npm ci",
        "build-mode: manual",
        "npm run cap:sync:check:ios",
        "-project apps/capture/ios/App/App.xcodeproj",
        "-scheme App",
        "-destination 'generic/platform=iOS Simulator'",
        "CODE_SIGNING_ALLOWED=NO",
        "COMPILATION_CACHE_ENABLE_CACHING=NO",
        "SWIFT_ENABLE_COMPILE_CACHE=NO",
        "SWIFT_USE_INTEGRATED_DRIVER=NO",
        'category: "/language:swift"',
    ):
        assert required in swift_job

    assert swift_job.index("github/codeql-action/init@") < swift_job.index(
        "npm run cap:sync:check:ios"
    )
    assert swift_job.index("npm run cap:sync:check:ios") < swift_job.index("xcodebuild")
    assert swift_job.index("xcodebuild") < swift_job.index("github/codeql-action/analyze@")


def test_codeql_actions_are_immutably_pinned_and_upload_is_least_privilege() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    action_references = re.findall(r"^\s*-?\s*uses:\s*([^\s#]+)", workflow, re.MULTILINE)

    assert action_references
    for reference in action_references:
        assert re.search(r"@[0-9a-f]{40}$", reference), reference
    assert workflow.count("actions: read") == 2
    assert workflow.count("security-events: write") == 2
    assert workflow.count("contents: read") == 3
    assert workflow.count("persist-credentials: false") == 2
    assert "packages: read" not in workflow
    assert "id-token: write" not in workflow
