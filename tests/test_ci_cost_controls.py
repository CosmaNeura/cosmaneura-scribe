from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_WORKFLOWS = (
    ROOT / ".github" / "workflows" / "ci.yml",
    ROOT / ".github" / "workflows" / "capture-e2e.yml",
)


def _trigger_block(workflow: str) -> str:
    start = workflow.index("on:\n")
    end = workflow.index("\npermissions:", start)
    return workflow[start:end]


def _job_blocks(workflow: str) -> list[tuple[str, str]]:
    jobs = workflow.split("\njobs:\n", 1)[1]
    matches = list(re.finditer(r"(?m)^  ([a-z][a-z0-9-]*):\n", jobs))
    return [
        (
            match.group(1),
            jobs[
                match.end() : matches[index + 1].start() if index + 1 < len(matches) else len(jobs)
            ],
        )
        for index, match in enumerate(matches)
    ]


def test_required_workflows_run_once_per_pr_head_and_cancel_superseded_runs() -> None:
    for path in REQUIRED_WORKFLOWS:
        workflow = path.read_text(encoding="utf-8")
        trigger = _trigger_block(workflow)

        assert re.search(r"(?m)^  pull_request:\s*$", trigger)
        assert not re.search(r"(?m)^  push:", trigger)
        assert "workflow_dispatch:" not in trigger
        assert re.search(
            r"(?ms)^concurrency:\n"
            r"  group: \$\{\{ github\.workflow \}\}-"
            r"\$\{\{ github\.event\.pull_request\.number \}\}\n"
            r"  cancel-in-progress: true$",
            workflow,
        )


def test_every_required_workflow_job_has_a_finite_timeout() -> None:
    for path in REQUIRED_WORKFLOWS:
        workflow = path.read_text(encoding="utf-8")
        for job_name, job in _job_blocks(workflow):
            timeout = re.search(r"(?m)^    timeout-minutes: ([0-9]+)$", job)
            assert timeout, f"{path.name}:{job_name} must have a finite timeout"
            assert 1 <= int(timeout.group(1)) <= 60
