"""Offline external-service substitutions; no live capture is qualified."""
import base64
from contextlib import nullcontext
from datetime import datetime, UTC, timedelta
import importlib.util
import json
from pathlib import Path
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location('reader_under_test', Path(__file__).with_name('live-bot-reader.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Cursor:
    def __init__(self, db):
        self.db = db
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def execute(self, sql, params=None):
        self.db.queries.append((sql, params))
        if 'current_database' in sql:
            self.rows = [('staging', 'cosmaneuraprodpostgresadmin', 'on')]
        elif 'alembic_version' in sql:
            self.rows = [('3d40e4e90e05',)]
        elif 'SELECT count(*)' in sql:
            self.rows = [(1,)]
        else:
            self.db.correspondence += 1
            self.rows = [] if self.db.correspondence == self.db.refuse_at else [self.db.row]
    def fetchone(self):
        return self.rows[0]
    def fetchall(self):
        return self.rows


class DB:
    def __init__(self, row):
        self.row = row
        self.queries = []
        self.correspondence = 0
        self.refuse_at = None
    def transaction(self):
        return nullcontext()
    def cursor(self):
        return Cursor(self)


class Provider:
    def __init__(self, data):
        self.data = data
        self.calls = []
        self.status_code = 200
    def stream(self, method, url):
        self.calls.append((method, url))
        return nullcontext(self)
    def iter_bytes(self):
        yield json.dumps(self.data).encode()


def fixture():
    reader = module.Reader.__new__(module.Reader)
    typed = lambda prefix: prefix + '_' + '0' * 26
    reader.expected = {'runId': str(uuid.uuid4()), 'collectorSHA256': 'a' * 64,
        'startedAtEpochMs': time.time() * 1000 - 60000,
        'accountIdentitySHA256': module.sha('synthetic-subject'), 'doctorRef': typed('doctor'),
        'patientRefSHA256': module.sha(typed('patient')), 'hostIdSHA256': module.sha('synthetic-host'),
        'meetingRecordRef': typed('zmtg'), 'meetingIdSHA256': module.sha('12345'),
        'appointmentRef': typed('appointment'), 'occurrenceDigest': 'b' * 64}
    reader.private = {'clerkSubject': 'synthetic-subject', 'patientRef': typed('patient'),
                      'meetingId': '12345', 'botId': 'synthetic-bot', 'recordingId': 'synthetic-recording'}
    reader.root = b'x' * 32
    reader.ids = {key: str(uuid.uuid4()) for key in ('doctor', 'meeting', 'appointment', 'patient')}
    reader.deployment = {'schema': '3d40e4e90e05'}
    at = datetime.now(UTC) - timedelta(seconds=40)
    reader.db = DB(('synthetic-subject', None, '12345', 'started', 'b' * 64, at, at + timedelta(minutes=5),
                    module.provider_reference('recall:capture:bot:synthetic-bot', reader.root),
                    module.provider_reference('recall:capture:recording:synthetic-recording', reader.root), at, 'b' * 64,
                    'synthetic-host', None))
    class Cache:
        def __init__(self):
            self.runtime = ['synthetic-bot', 'b' * 64, 'synthetic-host', typed('doctor'), '1', '1', None, None]
        def mget(self, keys):
            if len(keys) == 8:
                return self.runtime
            return [typed('doctor'), typed('appointment'), typed('patient')]
    reader.cache = Cache()
    reader.scope = {key: reader.expected[key] for key in module.SCOPE_KEYS}
    reader.scope.update(botIdSHA256=module.sha('synthetic-bot'), recordingIdSHA256=module.sha('synthetic-recording'))
    reader.sequence = 0; reader.nonces = set(); reader.consent = None; reader.recording_evidence = None; reader.host_end = None
    reader.started = time.monotonic(); reader.accepted = False; reader.blocked = False; reader.closed = False
    reader.provider = Provider({'id': 'synthetic-bot', 'meeting_url': {'platform': 'zoom', 'meeting_id': '12345'},
        'status_changes': [{'code': 'joining_call', 'sub_code': None, 'created_at': at.isoformat()},
                           {'code': 'in_call_not_recording', 'sub_code': None, 'created_at': at.isoformat()}],
        'recordings': [
            {'id': 'older-recording', 'status': {'code': 'done'}, 'started_at': at.isoformat(), 'completed_at': at.isoformat()},
            {'id': 'synthetic-recording', 'status': {'code': 'processing'}, 'started_at': at.isoformat(), 'completed_at': None}],
        'provider_token': 'NEVER_EXPORT', 'transcript': 'NEVER_EXPORT'})
    request = {'version': 1, 'runId': reader.expected['runId'], 'action': 'observe',
               'requestNonce': str(uuid.uuid4()), 'consent': {'offline': 'consent-fixture'},
               'recordingEvidence': {'offline': 'rec-indicator-fixture'}, 'hostEnd': None}
    return reader, request


class Tests(unittest.TestCase):
    def test_real_read_method_brackets_one_exact_get_and_strips_content(self):
        reader, request = fixture()
        value = reader.observe(request)
        self.assertEqual([value['core']['before']['readSequence'], value['provider']['readSequence'], value['core']['after']['readSequence']], [1, 2, 3])
        self.assertEqual(reader.provider.calls, [('GET', 'https://us-west-2.recall.ai/api/v1/bot/synthetic-bot/')])
        self.assertNotIn('NEVER_EXPORT', json.dumps(value))
        self.assertEqual(reader.db.correspondence, 2)
        self.assertEqual(len(value['provider']['recordings']), 1)
        self.assertEqual(value['provider']['recordings'][0]['idSHA256'], module.sha('synthetic-recording'))
        self.assertEqual(value['provider']['statusChanges'][-1]['code'], 'in_call_not_recording')
        self.assertTrue(all(not sql.lstrip().upper().startswith(('UPDATE', 'DELETE', 'INSERT')) for sql, _ in reader.db.queries))

    def test_no_provider_call_without_joined_authority(self):
        reader, request = fixture(); reader.db.refuse_at = 1
        with self.assertRaisesRegex(ValueError, 'core_correspondence_missing_or_ambiguous'):
            reader.observe(request)
        self.assertEqual(reader.provider.calls, [])

    def test_authority_withdrawn_after_get_has_no_dto(self):
        reader, request = fixture(); reader.db.refuse_at = 2
        with self.assertRaisesRegex(ValueError, 'core_correspondence_missing_or_ambiguous'):
            reader.observe(request)
        self.assertEqual(len(reader.provider.calls), 1)

    def test_nonce_replay_does_not_read_again(self):
        reader, request = fixture(); reader.observe(request)
        with self.assertRaisesRegex(ValueError, 'request_invalid'):
            reader.observe(request)
        self.assertEqual(len(reader.provider.calls), 1)

    def test_foreign_provider_meeting_and_duplicate_exact_recording_refuse(self):
        for mutation in ('meeting', 'recording', 'missing', 'identity'):
            with self.subTest(mutation=mutation):
                reader, request = fixture()
                if mutation == 'meeting': reader.provider.data['meeting_url']['meeting_id'] = '67890'
                elif mutation == 'recording': reader.provider.data['recordings'].append(reader.provider.data['recordings'][1].copy())
                elif mutation == 'missing': reader.provider.data['recordings'][1]['id'] = 'another-recording'
                else: reader.provider.data['id'] = 'another-bot'
                with self.assertRaises(ValueError): reader.observe(request)

    def test_live_core_requires_active_started_and_no_terminal_markers(self):
        for index, value in ((4, None), (4, '0'), (5, None), (5, '0'), (6, 'done')):
            with self.subTest(index=index, value=value):
                reader, request = fixture(); reader.cache.runtime[index] = value
                with self.assertRaisesRegex(ValueError, 'core_not_current_recording'):
                    reader.observe(request)
                self.assertEqual(reader.provider.calls, [])
        reader, request = fixture(); row = list(reader.db.row); row[12] = 'done'; reader.db.row = tuple(row)
        with self.assertRaisesRegex(ValueError, 'core_authority_changed'):
            reader.observe(request)
        self.assertEqual(reader.provider.calls, [])

    def test_recording_indicator_binding_is_pinned_across_reads(self):
        reader, request = fixture(); reader.observe(request)
        next_request = dict(request, requestNonce=str(uuid.uuid4()), recordingEvidence={'offline': 'changed'})
        with self.assertRaisesRegex(ValueError, 'recording_evidence_changed'):
            reader.observe(next_request)
        self.assertEqual(len(reader.provider.calls), 1)

    def test_provider_meeting_shapes_accept_only_zoom_numeric_identity(self):
        self.assertEqual(module.meeting_identity('https://us06web.zoom.us/j/12345?pwd=private'), '12345')
        self.assertEqual(module.meeting_identity({'platform': 'zoom', 'meeting_id': '12345'}), '12345')
        for value in ('https://zoom.us.attacker.example/j/12345', 'https://zoom.us@attacker.example/j/12345',
                      'https://zoom.us/recording/12345', {'platform': 'meet', 'meeting_id': '12345'}):
            with self.assertRaises(ValueError): module.meeting_identity(value)

    def test_key_ring_and_legacy_roots_are_context_separated(self):
        legacy = base64.urlsafe_b64encode(b'x' * 32).decode()
        root = module.pseudonym_root(legacy)
        ring = json.dumps({'version': 1, 'pseudonym_root_key_id': 'fixture', 'pseudonym_root_key': base64.urlsafe_b64encode(root).decode()})
        self.assertEqual(module.pseudonym_root(ring), root)
        self.assertNotEqual(module.provider_reference('recall:capture:bot:fixture', root), module.provider_reference('recall:capture:recording:fixture', root))


if __name__ == '__main__':
    unittest.main()
