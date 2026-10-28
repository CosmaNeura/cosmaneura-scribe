"""One reviewed ACA exec connection; resident nonce observations use its pipe.

Selection is a protected, root-reviewed sibling file. Existing retained Azure
user-token validation is mandatory. No generic command, endpoint or credential
can be supplied by the observation caller. Terminal/control output is discarded.
"""
from datetime import datetime, UTC
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import select
import stat
import subprocess
import sys
import termios
import time

MAX_LINE = 262144
MAX_BOOT_BYTES = 262144
MAX_LIFETIME = 3600
R = Path(__file__).resolve().parent


def need(value, code):
    if not value:
        raise ValueError(code)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def read(path, private=False, limit=131072):
    path = Path(path)
    info = path.lstat()
    need(path.is_absolute() and path.resolve() == path and stat.S_ISREG(info.st_mode)
         and info.st_uid == os.getuid() and info.st_size <= limit
         and (not private or info.st_mode & 0o077 == 0), 'owned_file_pin_required')
    return path.read_bytes()


def load(path, pin, name):
    need(sha(read(path)) == pin, 'source_pin_changed')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def selection():
    raw = read(R / 'live-bot-selection.json', private=True, limit=16384)
    value = json.loads(raw)
    need(value.get('version') == 1 and value.get('status') == 'APPROVED_OWNED_R8_READ_ONLY_LIVE_COLLECTOR'
         and value.get('providerMutations') == value.get('recordMutations') == 0
         and value.get('publicListener') is False
         and value.get('operatorSHA256') == sha(read(Path(__file__)))
         and value.get('boundCliSHA256') == sha(read(R / 'live-bot-bound-cli.py')),
         'exact_root_selection_required')
    issued = datetime.fromisoformat(value['issuedAt'])
    expires = datetime.fromisoformat(value['expiresAt'])
    need(issued.utcoffset() == expires.utcoffset() == UTC.utcoffset(None)
         and issued <= datetime.now(UTC) < expires and 0 < (expires - issued).total_seconds() <= MAX_LIFETIME,
         'root_selection_expired')
    need(value['webApp'] == value['container'] == 'cosmaneura-staging-app'
         and re.fullmatch(r'cosmaneura-staging-app--[a-z0-9-]+', value['revision'])
         and re.fullmatch('[a-z0-9-]{1,160}', value['replica'])
         and re.fullmatch('sha256:[a-f0-9]{64}', value['image'])
         and re.fullmatch('[a-f0-9]{40}', value['coreSource'])
         and re.fullmatch('[a-f0-9]{32}', value['transportNonce']), 'exact_staging_target_required')
    for name in ('worker', 'ack', 'helper', 'boundAzure'):
        need(sha(read(value[name + 'Path'])) == value[name + 'SHA256'], 'retained_source_changed')
    return raw, value


def transfer(value):
    ack = load(value['ackPath'], value['ackSHA256'], 'live_bot_retained_ack')
    return ack, ack.TransferPlan(read(value['workerPath']), nonce=value['transportNonce'])


def exec_arguments(value, command, helper):
    return ['containerapp', 'exec', '--name', value['webApp'], '--resource-group', helper.GROUP,
            '--revision', value['revision'], '--replica', value['replica'], '--container', value['container'],
            '--command', command, '--subscription', helper.SUBSCRIPTION, '--only-show-errors', '--output', 'json']


def write_all(fd, data):
    while data:
        count = os.write(fd, data)
        need(count > 0, 'private_pipe_write_failed')
        data = data[count:]


def stream(process, master, ack, plan, config, scope, expires):
    state = ack.AckState(plan)
    terminal = bytearray()
    inputs = bytearray()
    boot_bytes = 0
    boot_started = time.monotonic()
    ready = False
    configured = False
    inflight = None
    seen = set()
    while datetime.now(UTC) < expires:
        need(process.poll() is None, 'owned_exec_closed')
        if not ready:
            need(time.monotonic() - boot_started < 90, 'owned_exec_startup_timeout')
        if inflight is not None:
            need(time.monotonic() - inflight[1] <= 2, 'resident_request_timeout')
        descriptors = [master] + ([sys.stdin.fileno()] if ready else [])
        readable, _, _ = select.select(descriptors, [], [], .05)
        for fd in readable:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            if fd != master:
                inputs.extend(data)
                need(len(inputs) <= 16384, 'request_frame_bound')
                if b'\n' not in inputs:
                    continue
                need(inputs.count(b'\n') == 1 and inputs.endswith(b'\n') and inflight is None, 'single_request_required')
                request = json.loads(inputs)
                need(isinstance(request, dict) and set(request) == {'version', 'runId', 'action', 'requestNonce', 'consent', 'hostEnd'}
                     and request['version'] == 1 and request['runId'] == scope['expected']['runId']
                     and request['action'] in ('observe', 'observeStopped', 'close')
                     and isinstance(request['requestNonce'], str) and re.fullmatch(r'[a-f0-9-]{36}', request['requestNonce'])
                     and request['requestNonce'] not in seen and len(seen) < 4160, 'request_scope_changed')
                seen.add(request['requestNonce'])
                inflight = (request['requestNonce'], time.monotonic())
                write_all(master, bytes(inputs)); inputs.clear()
                continue
            terminal.extend(data)
            need(len(terminal) <= MAX_LINE, 'terminal_frame_bound')
            while b'\n' in terminal:
                raw, _, rest = terminal.partition(b'\n')
                terminal = bytearray(rest)
                line = raw.rstrip(b'\r')
                if not ready:
                    boot_bytes += len(raw) + 1
                    need(boot_bytes <= MAX_BOOT_BYTES, 'bootstrap_output_bound')
                    frame = state.feed(raw)
                    if frame is not None:
                        write_all(master, frame)
                    if state.phase == 'executing' and not configured:
                        write_all(master, config); configured = True
                    if configured and line.startswith(b'{'):
                        result = json.loads(line)
                        need(set(result) == {'version', 'kind', 'runId', 'collectorSHA256', 'revision', 'schema'}
                             and result['version'] == 1 and result['kind'] == 'live-bot-reader-ready'
                             and result['runId'] == scope['expected']['runId']
                             and result['collectorSHA256'] == scope['expected']['collectorSHA256']
                             and result['revision'] == scope['deployment']['revision'] and result['schema'] == scope['deployment']['schema'],
                             'resident_readiness_unconfirmed')
                        ready = True
                        sys.stdout.buffer.write(line + b'\n'); sys.stdout.buffer.flush()
                    continue
                # After readiness only the sole nonce response is legal. Never
                # forward Azure messages, terminal text, traceback or prompts.
                need(inflight is not None and line.startswith(b'{'), 'unsolicited_resident_output')
                result = json.loads(line)
                need(isinstance(result, dict) and set(result) in (
                    {'version', 'runId', 'requestNonce', 'observation'}, {'version', 'runId', 'requestNonce', 'errorCode'},
                    {'version', 'runId', 'requestNonce', 'closed'})
                     and result['version'] == 1 and result['runId'] == scope['expected']['runId']
                     and result['requestNonce'] == inflight[0] and time.monotonic() - inflight[1] <= 2,
                     'resident_response_nonce_changed')
                inflight = None
                sys.stdout.buffer.write(line + b'\n'); sys.stdout.buffer.flush()
    raise ValueError('root_selection_expired')


def main():
    process = None
    master = slave = token_fd = None
    try:
        original, value = selection()
        config = sys.stdin.buffer.readline(16385)
        need(0 < len(config) <= 16384 and config.endswith(b'\n') and sha(config) == value['configurationSHA256'], 'exact_config_required')
        scope = json.loads(config)
        need(scope['expected']['collectorSHA256'] == value['workerSHA256']
             and scope['deployment']['revision'] == value['revision'], 'reader_configuration_changed')
        helper = load(value['helperPath'], value['helperSHA256'], 'live_bot_retained_helper')
        need(helper.command(['/usr/bin/git', '-C', value['coreCheckout'], 'rev-parse', 'HEAD']).decode().strip() == value['coreSource']
             and helper.command(['/usr/bin/git', '-C', value['coreCheckout'], 'status', '--porcelain']) == b'', 'core_source_changed')
        before, _ = helper.observe(value['webApp'])
        need(before['image'] == before['ready_image'] == value['image']
             and before['revision'] == before['ready_revision'] == value['revision'], 'current_ready_replica_required')
        replicas = helper.az(value['webApp'], ['containerapp', 'replica', 'list'], '--revision', value['revision'])
        need(any(row['name'] == value['replica'] and any(item['name'] == value['container'] and item.get('ready') is True
             for item in row['properties']['containers']) for row in replicas), 'selected_replica_not_ready')
        ack, plan = transfer(value)
        token = helper.command([helper.AZ, 'account', 'get-access-token', '--subscription', helper.SUBSCRIPTION,
                                '--resource', 'https://management.azure.com/', '--output', 'json', '--only-show-errors'])
        need(len(token) <= 8192 and selection()[0] == original, 'fresh_bound_token_required')
        token_fd, writer = os.pipe()
        try:
            write_all(writer, token)
        finally:
            os.close(writer)
        del token
        args = exec_arguments(value, plan.command, helper)
        argv = ['/bin/bash', '-c', 'exec "$@" 3<&' + str(token_fd), 'owned-live-bot-exec',
                helper.AZ_PYTHON, '-I', '-B', str(R / 'live-bot-bound-cli.py'), *args]
        master, slave = pty.openpty()
        modes = termios.tcgetattr(slave)
        modes[3] &= ~(termios.ECHO | termios.ICANON)
        termios.tcsetattr(slave, termios.TCSANOW, modes)
        process = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, pass_fds=(token_fd,),
                                   env={**os.environ, 'AZURE_LOGGING_ENABLE_LOG_FILE': 'false', 'AZURE_CORE_COLLECT_TELEMETRY': 'false'})
        os.close(slave); slave = None
        os.close(token_fd); token_fd = None
        stream(process, master, ack, plan, config, scope, datetime.fromisoformat(value['expiresAt']))
    except BaseException:
        # Fixed failure only. Credentials, host IDs, URLs and terminal output
        # never escape through an error diagnostic or the tool transcript.
        print(json.dumps({'version': 1, 'kind': 'live-bot-private-transport-refused', 'errorCode': 'owned_stream_unconfirmed'}), flush=True)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=2)
        for descriptor in (master, slave, token_fd):
            if descriptor is not None:
                os.close(descriptor)


if __name__ == '__main__':
    main()
