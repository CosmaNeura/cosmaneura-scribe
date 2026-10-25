#!/usr/bin/env python3
"""Build unchanged locked ClerkKit in an owned package; retain metadata, never raw logs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
LOCK = REPO / "apps/capture/native-plugins/cosmas-native-auth/clerk-source-lock.json"
LOCK_SHA = "5a32ce8777ce4ceefc78e475074933d6062008a19175a8ce4490453739f652e9"
DEFAULT_VENDOR = Path("/private/tmp/scribe-mac120-release-preparation-20261023/source/apps/capture/native-plugins/cosmas-native-auth/vendor")
TEST_NAMES = {
    "testPersistenceAndIdentityIsolation", "testTicketUsesRealSDKPipelineAndFailsClosedOffline",
    "testForcedTokenFailuresDoNotYieldTokenAndReconfigurationDropsSession",
    "testPersistentSharedSessionModeRejectedWithInjectedStorage",
    "testLiveEmailCodeTwoSyntheticIdentitiesAndRecovery",
    "testLiveTicketTwoSyntheticIdentitiesAndRecovery", "testLivePublicStagingEnvironment",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def materialize(vendor, destination):
    if digest(LOCK.read_bytes()) != LOCK_SHA:
        raise ValueError("source_lock_changed")
    files = json.loads(LOCK.read_text())["files"]
    actual = {str(p.relative_to(vendor)) for p in vendor.rglob("*") if p.is_file()}
    if actual != set(files):
        raise ValueError("vendor_inventory_mismatch")
    for relative, expected in files.items():
        source = vendor / relative
        if source.is_symlink() or not source.resolve().is_relative_to(vendor.resolve()):
            raise ValueError("vendor_path_not_regular")
        content = source.read_bytes()
        if digest(content) != expected:
            raise ValueError("vendor_hash_mismatch")
        target = destination / "vendor" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    shutil.copyfile(HERE / "Package.swift", destination / "Package.swift")
    shutil.copytree(HERE / "Tests", destination / "Tests")
    return len(files)


def execute(command, env, timeout):
    started = time.monotonic()
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True)
    timed_out, group_kill_sent, drain_completed = False, False, True

    def stop_owned_group():
        nonlocal group_kill_sent, drain_completed
        # start_new_session makes this PID the group leader; never target our caller.
        try:
            os.killpg(process.pid, signal.SIGKILL)
            group_kill_sent = True
        except ProcessLookupError:
            pass
        try:
            return process.communicate(timeout=3)[0]
        except subprocess.TimeoutExpired as error:
            drain_completed = False
            process.stdout.close()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            return error.output or b""

    try:
        content = process.communicate(timeout=timeout)[0]
        code = process.returncode
    except subprocess.TimeoutExpired:
        timed_out = True
        content, code = stop_owned_group(), 124
    except BaseException:
        stop_owned_group()
        raise
    # Raw SDK/compiler output remains in process memory only and is not printed/saved.
    metadata = {"exit_code": code, "duration_seconds": round(time.monotonic() - started, 2),
                "output_sha256": digest(content), "output_bytes": len(content),
                "timed_out": timed_out, "group_kill_sent": group_kill_sent,
                "output_drain_completed": drain_completed, "owned_process_reaped": process.poll() is not None}
    tests = {}
    for line in content.decode("utf-8", errors="replace").splitlines():
        match = re.search(r"Test Case .*\b(test\w+)[\]']* (passed|failed|skipped) ", line)
        if match and match[1] in TEST_NAMES:
            tests[match[1]] = match[2]
    metadata["tests"] = tests
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vendor", type=Path, default=DEFAULT_VENDOR)
    parser.add_argument("--output", type=Path, default=Path("/Users/jw/Desktop/Cosmas/Scribe-Virtual-Lab-20261024/native-auth"))
    parser.add_argument("--mode", choices=["offline", "public", "email", "ticket"], default="offline")
    parser.add_argument("--bootstrap", action="store_true", help="Create/reuse only the two approved synthetic +clerk_test accounts (email mode)")
    parser.add_argument("--bootstrap-domain", choices=["example.com", "cosmaneura.com"], default="example.com",
                        help="Explicit approved synthetic practice domain; never an arbitrary address")
    args = parser.parse_args()
    if args.bootstrap and args.mode != "email":
        parser.error("bootstrap_requires_email_mode")
    identifier = uuid.uuid4().hex[:12]
    output = args.output.resolve() / ("run-" + identifier)
    output.mkdir(parents=True, exist_ok=False)
    # Keep executable bundles off Desktop (Finder can attach code-signing detritus).
    run = Path("/private/tmp") / ("scribe-native-auth-lab-" + identifier)
    run.mkdir(exist_ok=False)
    receipt = {"schema": 1, "mode": args.mode, "package": str(run), "source_lock_sha256": LOCK_SHA,
               "harness_source_sha256": digest(Path(__file__).read_bytes()),
               "bootstrap": args.bootstrap, "live_account_proof": False, "core_authorization_proof": False,
               "lab_inputs": {str(p.relative_to(HERE)): digest(p.read_bytes()) for p in HERE.rglob("*")
                              if p.is_file() and "__pycache__" not in str(p)}}
    try:
        receipt["verified_vendor_files"] = materialize(args.vendor.resolve(), run)
        # Whitelisted build environment keeps credentials out of compiler processes.
        env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "DEVELOPER_DIR", "SDKROOT", "LANG") if key in os.environ}
        env.update({"SWIFTPM_MODULECACHE_OVERRIDE": str(run / "module-cache"),
                    "CLANG_MODULE_CACHE_PATH": str(run / "module-cache"),
                    "SWIFT_MODULECACHE_PATH": str(run / "module-cache")})
        flags = ["--package-path", str(run), "--scratch-path", str(run / ".build"),
                 "--cache-path", str(run / "cache"), "--config-path", str(run / "config"),
                 "--security-path", str(run / "security"), "--manifest-cache", "local", "--disable-sandbox"]
        build = execute(["swift", "build", *flags, "--build-tests", "-j", "4"], env, 300)
        receipt["build"] = build
        if build["exit_code"]:
            receipt["status"] = "build_failed"
        else:
            if args.mode in ("email", "ticket"):
                permitted = ["SCRIBE_LAB_SYNTHETIC_ONLY", "SCRIBE_LAB_CLERK_PUBLISHABLE_KEY",
                             "SCRIBE_LAB_USER_A_ID", "SCRIBE_LAB_USER_B_ID",
                             "SCRIBE_LAB_EMAIL_A", "SCRIBE_LAB_EMAIL_B", "SCRIBE_LAB_TICKET_A", "SCRIBE_LAB_TICKET_B"]
                env.update({key: os.environ[key] for key in permitted if key in os.environ})
            env.update({"SCRIBE_LAB_LIVE": "1" if args.mode != "offline" else "0",
                        "SCRIBE_LAB_AUTH_STRATEGY": args.mode,
                        "SCRIBE_LAB_BOOTSTRAP": "1" if args.bootstrap else "0",
                        "SCRIBE_LAB_BOOTSTRAP_DOMAIN": args.bootstrap_domain,
                        "SCRIBE_LAB_ACCOUNT_RECEIPT": str(output / "synthetic-accounts.json"),
                        "SCRIBE_LAB_PHASE_RECEIPT": str(output / "phase-result.json")})
            if args.bootstrap:
                env["SCRIBE_LAB_SYNTHETIC_ONLY"] = "1"
            test = execute(["swift", "test", *flags, "--skip-build", "--disable-swift-testing"], env, 150)
            receipt["test"] = test
            expected_live = {"public": "testLivePublicStagingEnvironment", "email": "testLiveEmailCodeTwoSyntheticIdentitiesAndRecovery",
                             "ticket": "testLiveTicketTwoSyntheticIdentitiesAndRecovery"}.get(args.mode)
            deterministic = {name for name in TEST_NAMES if not name.startswith("testLive")}
            passed = test["exit_code"] == 0 and all(test["tests"].get(name) == "passed" for name in deterministic)
            passed = passed and (not expected_live or test["tests"].get(expected_live) == "passed")
            receipt["status"] = "passed" if passed else "tests_failed_or_missing"
            receipt["live_account_proof"] = passed and args.mode in ("email", "ticket")
            receipt["public_clerk_network_proof"] = passed and args.mode == "public"
    except Exception:
        # Fixed classification only; never serialize paths/credentials from exceptions.
        receipt["status"] = "materialization_or_runner_failed"
    receipt_path = output / "native-result.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
