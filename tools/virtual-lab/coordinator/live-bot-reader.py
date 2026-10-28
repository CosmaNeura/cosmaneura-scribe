"""Resident, read-only Core -> exact Recall GET -> Core observation producer.

Executed through an already reviewed, hash-bound private exec transport. This
program opens no listener, imports no app module, mutates no record, decrypts
no payload, and never discovers a bot from provider listing or metadata.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import select
import sys
import time
import urllib.parse

MAX_INPUT = 16384
MAX_OUTPUT = 262144
MAX_PROVIDER = 1048576
MAX_REQUESTS = 4160
LIFETIME_SECONDS = 3600
PROOF_SECONDS = 1.8  # Leaves transport time inside the unchanged 2-second gate.
SCOPE_KEYS = ('accountIdentitySHA256', 'doctorRef', 'patientRefSHA256',
              'hostIdSHA256', 'meetingRecordRef', 'meetingIdSHA256',
              'appointmentRef', 'occurrenceDigest')
STARTUP = ('.tool-versions', 'Procfile', 'alembic.ini', 'main.py',
           'nixpacks.toml', 'pyproject.toml', 'uv.lock')


def need(condition, code):
    if not condition:
        raise ValueError(code)


def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def uuid(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', value)


def iso(value):
    need(value is not None and value.tzinfo is not None, 'timestamp_missing')
    return value.isoformat()


def provider_reference(value, root):
    # Exact existing app/utils/encryption.py v1 context separation. The runtime
    # manifest is checked before the key is read; no application setup runs.
    context = b'provider-reference'
    encoded = value.encode()
    message = (b'cosmaneura:pseudonym:v1\x00' + len(context).to_bytes(2, 'big')
               + context + len(encoded).to_bytes(8, 'big') + encoded)
    return hmac.new(root, message, hashlib.sha256).hexdigest()


def pseudonym_root(value):
    need(isinstance(value, str) and 0 < len(value) <= 16384, 'key_configuration_invalid')
    value = value.strip()
    if value.startswith('{'):
        ring = json.loads(value)
        need(ring.get('version') == 1 and isinstance(ring.get('pseudonym_root_key_id'), str)
             and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', ring['pseudonym_root_key_id']), 'key_configuration_invalid')
        root = base64.b64decode(ring['pseudonym_root_key'], altchars=b'-_', validate=True)
    else:
        decoded = base64.b64decode(value, altchars=b'-_', validate=True)
        need(len(decoded) == 32, 'key_configuration_invalid')
        root = hmac.new(decoded, b'cosmaneura:pseudonym-root:v1', hashlib.sha256).digest()
    need(len(root) == 32, 'key_configuration_invalid')
    return root


def runtime(deployment):
    need(exact(deployment, ('revision', 'runtimeSHA256', 'runtimeFileCount', 'schema', 'recallKeySHA256'))
         and deployment['schema'] == '3d40e4e90e05'
         and os.environ.get('PYTHON_ENV') == 'staging'
         and os.environ.get('CONTAINER_APP_NAME') == 'cosmaneura-staging-app'
         and os.environ.get('CONTAINER_APP_REVISION') == deployment['revision'], 'runtime_scope_changed')
    root = Path('/app')
    files = []
    for folder in ('app', 'migrations'):
        for path in (root / folder).rglob('*'):
            need(not path.is_symlink(), 'runtime_link')
            if '__pycache__' not in path.parts and path.suffix != '.pyc' and path.is_file():
                files.append(path)
            need(len(files) <= 1000, 'runtime_file_bound')
    files.extend(root / name for name in STARTUP if (root / name).is_file())
    rows = []
    for path in sorted(files, key=lambda item: str(item.relative_to(root))):
        need(not path.is_symlink() and path.stat().st_size <= 16 * 1024 ** 2, 'runtime_file_invalid')
        rows.append((str(path.relative_to(root)), sha(path.read_bytes())))
    need(len(rows) == deployment['runtimeFileCount']
         and sha(json.dumps(rows, separators=(',', ':'), ensure_ascii=True)) == deployment['runtimeSHA256'], 'runtime_files_changed')


def meeting_identity(value):
    # These are the two explicit Recall bot response shapes; neither accepts a
    # callback/media URL, arbitrary platform, or a caller-supplied digest.
    if isinstance(value, dict):
        need(value.get('platform') == 'zoom' and isinstance(value.get('meeting_id'), str)
             and re.fullmatch(r'[0-9]{1,32}', value['meeting_id']), 'provider_meeting_unknown')
        return value['meeting_id']
    need(isinstance(value, str), 'provider_meeting_unknown')
    parsed = urllib.parse.urlsplit(value)
    need(parsed.scheme == 'https' and parsed.hostname is not None
         and (parsed.hostname == 'zoom.us' or parsed.hostname.endswith('.zoom.us'))
         and parsed.username is None and parsed.password is None and parsed.port in (None, 443), 'provider_meeting_unknown')
    match = re.fullmatch(r'/(?:j|wc)/([0-9]{1,32})(?:/join)?/?', parsed.path)
    need(match is not None, 'provider_meeting_unknown')
    return match[1]


def project_provider(data, bot, recording, meeting, sequence):
    need(isinstance(data, dict) and data.get('id') == bot
         and meeting_identity(data.get('meeting_url')) == meeting, 'provider_identity_changed')
    changes = data.get('status_changes')
    recordings = data.get('recordings')
    need(isinstance(changes, list) and 1 < len(changes) <= 512
         and isinstance(recordings, list) and len(recordings) == 1, 'provider_response_ambiguous')
    projected = []
    for row in changes:
        need(isinstance(row, dict) and all(key in row for key in ('code', 'sub_code', 'created_at')), 'provider_status_missing')
        projected.append({'code': row['code'], 'subCode': row['sub_code'], 'createdAt': row['created_at']})
    row = recordings[0]
    need(isinstance(row, dict) and row.get('id') == recording and recording != bot
         and isinstance(row.get('status'), dict) and 'code' in row['status']
         and all(key in row for key in ('started_at', 'completed_at')), 'provider_recording_changed')
    return {'source': 'scoped-recall-get-response', 'httpStatus': 200, 'readSequence': sequence,
            'botIdSHA256': sha(bot), 'meetingIdSHA256': sha(meeting), 'statusChanges': projected,
            'recordings': [{'idSHA256': sha(recording), 'botIdSHA256': sha(bot),
                            'statusCode': row['status']['code'], 'startedAt': row['started_at'],
                            'completedAt': row['completed_at']}]}


class Reader:
    def __init__(self, config):
        import psycopg
        import redis
        import httpx
        from typeid import TypeID
        need(exact(config, ('version', 'expected', 'privateScope', 'deployment')) and config['version'] == 1, 'configuration_invalid')
        self.expected = config['expected']
        self.private = config['privateScope']
        need(exact(self.expected, ('runId', 'collectorSHA256', 'startedAtEpochMs', *SCOPE_KEYS))
             and uuid(self.expected['runId'])
             and exact(self.private, ('clerkSubject', 'meetingId', 'patientRef', 'botId', 'recordingId')),
             'configuration_invalid')
        for key in ('collectorSHA256', 'accountIdentitySHA256', 'patientRefSHA256', 'hostIdSHA256', 'meetingIdSHA256', 'occurrenceDigest'):
            need(isinstance(self.expected[key], str) and re.fullmatch('[a-f0-9]{64}', self.expected[key]), 'configuration_invalid')
        need(sha(self.private['clerkSubject']) == self.expected['accountIdentitySHA256']
             and sha(self.private['meetingId']) == self.expected['meetingIdSHA256']
             and sha(self.private['patientRef']) == self.expected['patientRefSHA256']
             and re.fullmatch('[0-9]{1,32}', self.private['meetingId'])
             and all(isinstance(self.private[key], str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', self.private[key])
                     for key in ('botId', 'recordingId'))
             and self.private['botId'] != self.private['recordingId'], 'private_scope_changed')
        self.ids = {}
        for key, prefix, reference in (('doctor', 'doctor', self.expected['doctorRef']),
                                       ('meeting', 'zmtg', self.expected['meetingRecordRef']),
                                       ('appointment', 'appointment', self.expected['appointmentRef']),
                                       ('patient', 'patient', self.private['patientRef'])):
            parsed = TypeID.from_string(reference)
            need(parsed.prefix == prefix, 'type_reference_invalid')
            self.ids[key] = parsed.uuid
        runtime(config['deployment'])
        self.deployment = config['deployment']
        self.root = pseudonym_root(os.environ['ENCRYPTION_KEY'])
        key = os.environ['RECALL_API_KEY']
        need(sha(key) == self.deployment['recallKeySHA256']
             and os.environ.get('RECALL_API_BASE', '').rstrip('/') == 'https://us-west-2.recall.ai/api/v1', 'staging_provider_scope_changed')
        url = os.environ['DATABASE_URL'].replace('postgresql+psycopg://', 'postgresql://', 1)
        parsed = urllib.parse.urlsplit(url)
        need(parsed.hostname == 'cosmaneura-staging-postgres.postgres.database.azure.com'
             and urllib.parse.parse_qs(parsed.query).get('sslmode') == ['verify-full'], 'staging_database_required')
        self.db = psycopg.connect(url, connect_timeout=5, autocommit=True,
                                 options='-c default_transaction_read_only=on -c statement_timeout=250 -c lock_timeout=100 -c idle_in_transaction_session_timeout=3000')
        self.cache = redis.Redis.from_url(os.environ['REDIS_URL'], socket_connect_timeout=.25,
                                         socket_timeout=.25, retry_on_timeout=False)
        self.provider = httpx.Client(headers={'Authorization': 'Token ' + key}, timeout=httpx.Timeout(1.0),
                                     follow_redirects=False, trust_env=False)
        self.scope = {name: self.expected[name] for name in SCOPE_KEYS}
        self.scope.update(botIdSHA256=sha(self.private['botId']), recordingIdSHA256=sha(self.private['recordingId']))
        self.sequence = 0
        self.nonces = set()
        self.consent = None
        self.host_end = None
        self.started = time.monotonic()
        self.accepted = False
        self.blocked = False
        self.closed = False
        # Admission is actual Core authority before any provider call.
        self.core(False)

    def next_sequence(self):
        self.sequence += 1
        return self.sequence

    def core(self, stopped):
        with self.db.transaction():
            with self.db.cursor() as cur:
                cur.execute("SELECT current_database(),current_user,current_setting('transaction_read_only')")
                need(cur.fetchone() == ('staging', 'cosmaneuraprodpostgresadmin', 'on'), 'database_identity_changed')
                cur.execute('SELECT version_num FROM public.alembic_version')
                need(cur.fetchall() == [(self.deployment['schema'],)], 'schema_changed')
                cur.execute('''SELECT d.clerk_id,d.deleted_at,m.zoom_meeting_id,m.status,
                    m.capture_authorization_occurrence_digest,m.capture_authorization_consumed_at,m.capture_authorization_expires_at,
                    b.bot_digest,b.recording_digest,b.authorization_consumed_at,b.occurrence_digest,
                    i.provider_user_id
                    FROM public.zoom_meeting m JOIN public.doctor d ON d.id=m.doctor_id
                    JOIN public.appointment a ON a.id=m.appointment_id AND a.doctor_id=d.id
                    JOIN public.patient p ON p.id=a.patient_id AND p.doctor_id=d.id
                    JOIN public.zoom_capture_binding b ON b.zoom_meeting_id=m.id AND b.doctor_id=d.id
                    AND b.appointment_id=a.id AND b.patient_id=p.id
                    JOIN public.doctor_video_integration i ON i.doctor_id=d.id AND i.provider='zoom'
                    WHERE d.id=%s AND m.id=%s AND a.id=%s AND p.id=%s LIMIT 2''',
                            tuple(self.ids[key] for key in ('doctor', 'meeting', 'appointment', 'patient')))
                rows = cur.fetchall()
                need(len(rows) == 1, 'core_correspondence_missing_or_ambiguous')
                row = rows[0]
                need(row[0] == self.private['clerkSubject'] and row[1] is None
                     and row[2] == self.private['meetingId'] and sha(row[11]) == self.expected['hostIdSHA256']
                     and row[4] == row[10] == self.expected['occurrenceDigest']
                     and row[5] is not None and row[5] == row[9]
                     and row[7] == provider_reference('recall:capture:bot:' + self.private['botId'], self.root)
                     and row[8] == provider_reference('recall:capture:recording:' + self.private['recordingId'], self.root), 'core_authority_changed')
                cur.execute("SELECT count(*) FROM public.doctor_video_integration WHERE provider='zoom' AND provider_user_id=%s", (row[11],))
                need(cur.fetchone() == (1,), 'host_owner_ambiguous')
        prefix = 'recall:meeting:' + self.private['meetingId'] + ':'
        suffixes = ('bot_id', 'occurrence_digest', 'host_id', 'doctor_id', 'recording_active', 'merge_generation')
        values = self.cache.mget([prefix + name for name in suffixes])
        need(len(values) == len(suffixes), 'runtime_response_invalid')
        values = [value.decode('utf-8') if isinstance(value, bytes) else value for value in values]
        bot, occurrence, host, doctor, active, generation = values
        if not stopped:
            need(row[3] == 'started' and bot == self.private['botId'] and occurrence == self.expected['occurrenceDigest']
                 and sha(host or '') == self.expected['hostIdSHA256'] and doctor == self.expected['doctorRef']
                 and active is not None, 'core_not_current_recording')
        else:
            need(row[3] == 'ended' and bot in (None, self.private['botId'])
                 and occurrence in (None, self.expected['occurrenceDigest']) and active is None, 'core_end_unconfirmed')
        mappings = self.cache.mget(['recall:recording:' + self.private['recordingId'] + ':' + name
                                   for name in ('doctor_id', 'appointment_id', 'patient_id')])
        # Durable joined authority remains after Redis expiry. If legacy keys
        # are present, they must independently agree; absence is not teardown.
        mappings = [value.decode('utf-8') if isinstance(value, bytes) else value for value in mappings]
        need(all(value is None or value == expected for value, expected in zip(mappings,
             (self.expected['doctorRef'], self.expected['appointmentRef'], self.private['patientRef']))), 'legacy_mapping_foreign')
        runtime_row = {'botIdSHA256': None if bot is None else sha(bot), 'occurrenceDigest': occurrence}
        if stopped:
            need(generation is None or re.fullmatch('[0-9]{1,15}', generation), 'generation_invalid')
            runtime_row['mergeGeneration'] = None if generation is None else int(generation)
        return {'readSequence': self.next_sequence(), 'scope': self.scope.copy(), 'meetingStatus': row[3],
                'authorization': {'occurrenceDigest': row[4], 'consumedAt': iso(row[5]), 'expiresAt': iso(row[6])},
                'meetingRuntime': runtime_row, 'recordingMapping': {'doctorRef': self.expected['doctorRef'],
                'appointmentRef': self.expected['appointmentRef'], 'patientRefSHA256': self.expected['patientRefSHA256']}}

    def release(self, generation, host_end):
        from typeid import TypeID
        event = ('internal.zoom_bot_release:' + self.private['meetingId'] + ':' + self.private['botId'] + ':'
                 + self.expected['occurrenceDigest'] + ':' + ('none' if generation is None else str(generation))
                 + ':stop=1:cleanup=1:ended=1')
        digest = provider_reference(event, self.root)
        with self.db.cursor() as cur:
            cur.execute('''SELECT id,event_type,provider_event_digest,state,received_at,processed_at,lease_expires_at,last_error_code
                FROM public.external_webhook_delivery WHERE provider='zoom' AND provider_event_digest=%s
                AND event_type='internal.zoom_bot_release' LIMIT 2''', (digest,))
            rows = cur.fetchall()
        need(len(rows) == 1, 'canonical_release_missing_or_ambiguous')
        row = rows[0]
        return {'source': 'scoped-core-canonical-meeting-end-release', 'botIdSHA256': self.scope['botIdSHA256'],
                'occurrenceDigest': self.expected['occurrenceDigest'], 'generation': generation, 'inventory': 'UNKNOWN',
                'hostEnd': host_end, 'canonicalIntent': {'action': 'release', 'stopRecording': True,
                'cleanupSession': True, 'markMeetingEnded': True},
                'release': {'id': str(TypeID.from_uuid(row[0], 'webhook_delivery')), 'eventType': row[1],
                'providerEventDigest': row[2], 'state': row[3], 'receivedAt': iso(row[4]),
                'processedAt': None if row[5] is None else iso(row[5]), 'leaseExpiresAt': None if row[6] is None else iso(row[6]),
                'lastErrorCode': row[7]}}

    def observe(self, request):
        need(exact(request, ('version', 'runId', 'action', 'requestNonce', 'consent', 'hostEnd'))
             and request['version'] == 1 and request['runId'] == self.expected['runId']
             and uuid(request['requestNonce']) and request['requestNonce'] not in self.nonces
             and request['action'] in ('observe', 'observeStopped') and not self.closed
             and len(self.nonces) < MAX_REQUESTS and time.monotonic() - self.started < LIFETIME_SECONDS, 'request_invalid')
        self.nonces.add(request['requestNonce'])
        stopped = request['action'] == 'observeStopped'
        need(stopped or not self.blocked, 'recording_restart_forbidden')
        need(not stopped or self.accepted, 'stop_before_capture')
        if self.consent is None:
            self.consent = request['consent']
        need(request['consent'] == self.consent, 'consent_changed')
        if stopped:
            need(request['hostEnd'] is not None, 'normal_host_end_missing')
            if self.host_end is None:
                self.host_end = request['hostEnd']
            need(self.host_end == request['hostEnd'], 'normal_host_end_changed')
        else:
            need(request['hostEnd'] is None, 'unexpected_end_evidence')
        started = time.monotonic()
        before = self.core(stopped)
        with self.provider.stream('GET', 'https://us-west-2.recall.ai/api/v1/bot/' + self.private['botId'] + '/') as response:
            need(response.status_code == 200, 'provider_http_unconfirmed')
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                need(len(body) <= MAX_PROVIDER and time.monotonic() - started < PROOF_SECONDS, 'provider_response_bound')
            provider = project_provider(json.loads(body), self.private['botId'], self.private['recordingId'],
                                        self.private['meetingId'], self.next_sequence())
        after = self.core(stopped)
        teardown = self.release(after['meetingRuntime']['mergeGeneration'], request['hostEnd']) if stopped else None
        need(time.monotonic() - started < PROOF_SECONDS, 'proof_deadline')
        result = {'schema': 1, 'kind': 'zoom-bot', 'source': 'normal-zoom-ui-and-scoped-recall-observation',
                  'executionKind': 'live', 'runId': self.expected['runId'], 'requestNonce': request['requestNonce'],
                  'collectorSHA256': self.expected['collectorSHA256'], 'scope': self.scope.copy(), 'consent': self.consent,
                  'core': {'source': 'scoped-staging-zoom-recording-correspondence', 'before': before, 'after': after},
                  'provider': provider, 'teardown': teardown}
        self.accepted = True
        if stopped:
            self.blocked = True
        return result

    def close(self):
        self.closed = True
        for name in ('provider', 'cache', 'db'):
            resource = getattr(self, name, None)
            if resource is not None:
                resource.close()


def read_line(timeout=LIFETIME_SECONDS):
    need(select.select([sys.stdin.fileno()], [], [], timeout)[0], 'reader_lifetime_expired')
    raw = sys.stdin.buffer.readline(MAX_INPUT + 1)
    need(0 < len(raw) <= MAX_INPUT and raw.endswith(b'\n'), 'input_frame_invalid')
    return json.loads(raw)


def send(value):
    raw = json.dumps(value, separators=(',', ':'), ensure_ascii=True)
    need(len(raw.encode()) <= MAX_OUTPUT, 'output_frame_bound')
    print(raw, flush=True)


def main():
    reader = None
    try:
        reader = Reader(read_line())
        send({'version': 1, 'kind': 'live-bot-reader-ready', 'runId': reader.expected['runId'],
              'collectorSHA256': reader.expected['collectorSHA256'], 'revision': reader.deployment['revision'],
              'schema': reader.deployment['schema']})
        while True:
            request = read_line(max(.01, LIFETIME_SECONDS - (time.monotonic() - reader.started)))
            nonce = request.get('requestNonce') if isinstance(request, dict) else None
            try:
                if (exact(request, ('version', 'runId', 'action', 'requestNonce', 'consent', 'hostEnd'))
                        and request['version'] == 1 and request['runId'] == reader.expected['runId']
                        and request['action'] == 'close' and uuid(nonce) and nonce not in reader.nonces
                        and request['consent'] is None and request['hostEnd'] is None):
                    reader.close()
                    send({'version': 1, 'runId': reader.expected['runId'], 'requestNonce': nonce, 'closed': True})
                    break
                result = reader.observe(request)
                send({'version': 1, 'runId': reader.expected['runId'], 'requestNonce': nonce, 'observation': result})
            except Exception as error:
                reader.blocked = True
                code = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z_]{1,96}', str(error)) else 'live_read_unconfirmed'
                send({'version': 1, 'runId': reader.expected['runId'], 'requestNonce': nonce, 'errorCode': code})
    except Exception:
        send({'version': 1, 'kind': 'live-bot-reader-refused', 'errorCode': 'reader_start_or_frame_unconfirmed'})
    finally:
        if reader is not None:
            reader.close()


if __name__ == '__main__':
    main()
