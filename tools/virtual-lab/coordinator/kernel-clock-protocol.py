"""Actual read-only helper protocol regression; pass an owned compiled binary.

This creates no app/audio target and makes no remote performance claim.
"""
import json
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

binary = Path(sys.argv[1]).absolute()
assert binary.is_file() and binary.resolve() == binary
run_id = str(uuid.uuid4())
command = [str(binary), "--scribe-virtual-lab-owner=" + run_id]


def request():
    return (json.dumps({"operation": "sample", "nonce": str(uuid.uuid4())}) + "\n").encode()


normal = subprocess.run(command, input=request(), capture_output=True, timeout=4)
assert normal.returncode == 0 and normal.stderr == b""
reply = json.loads(normal.stdout)
assert reply["runId"] == run_id and reply["sequence"] == 1
empty = subprocess.run(command, input=b"", capture_output=True, timeout=4)
assert empty.returncode == 0 and empty.stdout == b""
invalid = subprocess.run(command, input=b'{"operation":"sample","nonce":"invalid"}\n', capture_output=True, timeout=4)
assert invalid.returncode == 2 and invalid.stdout == b""

# Use a real OS pipe, not a buffered Node reader. Keep its read end open but
# deliberately never read it until the child exits. Keep the parent and stdin
# alive too, so EOF or a dead parent cannot accidentally make this test pass.
read_fd, write_fd = os.pipe()
# Do not assume the operating system's pipe capacity. Fill this owned pipe to
# actual EAGAIN, then restore blocking mode before either helper is spawned.
flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
fcntl.fcntl(write_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
prefilled = 0
while True:
    try:
        prefilled += os.write(write_fd, b"x" * 4096)
        assert prefilled <= 4 * 1024 * 1024, "unexpected_pipe_capacity"
    except BlockingIOError:
        break
assert prefilled > 0
fcntl.fcntl(write_fd, fcntl.F_SETFL, flags)
child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=write_fd, stderr=subprocess.PIPE)
os.close(write_fd)
started = time.monotonic()
try:
    assert child.stdin is not None
    child.stdin.write(request())
    child.stdin.flush()
    code = child.wait(timeout=4)
    elapsed = time.monotonic() - started
    assert code == 2 and elapsed < 4, (code, elapsed)
    # This same executable already passed a valid sample above. This time its
    # response encountered a pipe proven full before the request was submitted.
    data = bytearray()
    while True:
        block = os.read(read_fd, 65536)
        if not block:
            break
        data.extend(block)
    assert bytes(data) == b"x" * prefilled
    assert child.stderr is not None and child.stderr.read() == b""
finally:
    if child.poll() is None:
        child.kill()
        child.wait(timeout=2)
    os.close(read_fd)
    if child.stdin is not None:
        try:
            child.stdin.close()
        except BrokenPipeError:
            pass

print(json.dumps({"status": "PASS", "checks": 4, "normalEOF": True, "emptyEOF": True,
                  "invalidNonceRefused": True, "saturatedPipeBounded": True,
                  "saturatedExitSeconds": elapsed, "prefilledBytes": prefilled,
                  "parentStayedAlive": True, "audioGraphCreated": False}))
