from __future__ import annotations

import importlib.util
import subprocess
import sys
import textwrap
from dataclasses import dataclass
from pathlib import Path

import pytest

LOAD_DIR = Path(__file__).parent / "load"


def _load_module():
    path = LOAD_DIR / "support.py"
    spec = importlib.util.spec_from_file_location("capture_load_support", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


support = _load_module()


@dataclass
class StubStats:
    name: str = "Aggregated"
    num_requests: int = 1000
    num_failures: int = 0
    p95: float | None = 100

    @property
    def fail_ratio(self) -> float:
        return self.num_failures / self.num_requests if self.num_requests else 0.0

    def get_response_time_percentile(self, percent: float) -> float | None:
        assert percent == 0.95
        return self.p95


def _failures(total: StubStats, *operations: StubStats, **overrides) -> list[str]:
    return support.threshold_failures(total, operations, support.Thresholds(**overrides))


def test_workload_rejects_non_loopback_host() -> None:
    with pytest.raises(RuntimeError, match="restricted to the local synthetic E2E host"):
        support.require_local_host("https://example.invalid")


@pytest.mark.parametrize("host", sorted(support.LOCAL_HOSTS))
def test_workload_accepts_each_local_host(host: str) -> None:
    support.require_local_host(host)


def test_thresholds_pass_with_failures_within_tolerance() -> None:
    total = StubStats(num_failures=10)

    assert _failures(total, StubStats(name="POST consent")) == []


def test_minimum_request_gate() -> None:
    assert _failures(StubStats(num_requests=99)) == ["requests 99 < 100"]


def test_failure_ratio_gate() -> None:
    assert _failures(StubStats(num_failures=11)) == ["failure ratio 0.0110 > 0.0100"]


def test_aggregate_p95_gate() -> None:
    assert _failures(StubStats(p95=751)) == ["aggregate p95 751ms > 750ms"]


def test_per_operation_p95_gate_catches_slow_operation_hidden_by_aggregate() -> None:
    fast = StubStats(name="POST consent", p95=50)
    slow = StubStats(name="POST chunk registration", p95=900)

    assert _failures(StubStats(p95=200), fast, slow) == [
        "POST chunk registration p95 900ms > 750ms"
    ]


def test_per_operation_p95_override() -> None:
    slow = StubStats(name="POST chunk registration", p95=900)
    other = StubStats(name="POST consent", p95=800)

    assert _failures(
        StubStats(p95=200),
        slow,
        other,
        operation_max_p95_ms={"POST chunk registration": 1000},
    ) == ["POST consent p95 800ms > 750ms"]


def test_thresholds_from_env() -> None:
    thresholds = support.Thresholds.from_env(
        {
            "SCRIBE_LOAD_MIN_REQUESTS": "0",
            "SCRIBE_LOAD_MAX_FAILURE_RATIO": "0.05",
            "SCRIBE_LOAD_MAX_P95_MS": "500",
            "SCRIBE_LOAD_OPERATION_MAX_P95_MS": '{"POST lease renew": 900}',
        }
    )

    assert thresholds == support.Thresholds(0, 0.05, 500, {"POST lease renew": 900})


def _run_locust_python(script: str) -> subprocess.CompletedProcess[str]:
    # Locust monkey-patches the interpreter with gevent on import; keep it out of pytest.
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        cwd=LOAD_DIR,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


@pytest.mark.parametrize(
    ("failures", "p95", "expected"),
    [(10, 100, 0), (11, 100, 1), (0, 751, 1)],
)
def test_quitting_listener_sets_explicit_exit_code(failures: int, p95: int, expected: int) -> None:
    result = _run_locust_python(
        f"""
        from types import SimpleNamespace
        import locustfile

        total = SimpleNamespace(
            name="Aggregated",
            num_requests=1000,
            fail_ratio={failures} / 1000,
            get_response_time_percentile=lambda _percent: {p95},
        )
        environment = SimpleNamespace(
            stats=SimpleNamespace(total=total, entries={{}}),
            process_exit_code=None,
        )
        locustfile.enforce_thresholds(environment)
        print("exit", environment.process_exit_code)
        """
    )

    assert result.returncode == 0, result.stderr
    assert f"exit {expected}" in result.stdout


def test_locust_refuses_non_local_host_before_any_request() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "locust",
            "--locustfile",
            str(LOAD_DIR / "locustfile.py"),
            "--headless",
            "--host",
            "https://example.invalid",
            "--users",
            "1",
            "--run-time",
            "5m",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    output = result.stdout + result.stderr
    assert result.returncode == 1
    assert "restricted to the local synthetic E2E host" in output
    assert "Ramping to" not in output
    assert "Aggregated" not in output


@pytest.mark.parametrize("host", [None, *sorted(support.LOCAL_HOSTS)])
def test_init_listener_accepts_local_host(host: str | None) -> None:
    result = _run_locust_python(
        f"""
        from types import SimpleNamespace
        import locustfile

        locustfile.refuse_non_local_target(SimpleNamespace(host={host!r}), web_ui=None)
        print("accepted")
        """
    )

    assert result.returncode == 0, result.stderr
    assert "accepted" in result.stdout
