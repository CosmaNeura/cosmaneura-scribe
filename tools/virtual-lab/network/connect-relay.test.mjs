import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRelay, LIMITS, parseConnectHeader, parseRelayConfig, TARGET_HOST, TARGET_AUTHORITY } from './connect-relay.mjs';

const header = Buffer.from(`CONNECT ${TARGET_AUTHORITY} HTTP/1.1\r\nHost: ${TARGET_AUTHORITY}\r\nProxy-Connection: keep-alive\r\n\r\n`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = (port, now = Date.now()) => ({ version: 1, runId: 'aacd369a-6c02-4d75-90c9-2d053a14de43',
  hardwareUUIDSHA256: 'a'.repeat(64), listenPort: port,
  issuedAtUnixSeconds: Math.floor(now / 1000) - 1, expiresAtUnixSeconds: Math.floor(now / 1000) + 60 });
async function server(t, value) {
  const sockets = new Set();
  value.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { value.once('error', reject); value.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => value.close(resolve)); });
  return value.address().port;
}
async function port() {
  const value = net.createServer(); await new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  const result = value.address().port; await new Promise(resolve => value.close(resolve)); return result;
}
async function fixture(t, options = {}) {
  const upstreamPort = await server(t, net.createServer(socket => socket.pipe(socket)));
  let calls = 0;
  const relay = await createRelay(config(await port()), { ...options, dial: (host, remotePort) => {
    assert.equal(host, TARGET_HOST); assert.equal(remotePort, 443); calls++;
    return net.connect({ host: '127.0.0.1', port: upstreamPort });
  } });
  t.after(() => relay.stop()); return { relay, calls: () => calls };
}
async function client(t, relay) {
  const socket = net.connect({ host: '127.0.0.1', port: relay.snapshot().listenPort });
  socket.on('error', () => {}); t.after(() => socket.destroy()); await once(socket, 'connect'); return socket;
}
async function tunnel(t, relay) {
  const socket = await client(t, relay);
  const ready = new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => reject(Error('test_connect_timeout')), 1500);
    function received(chunk) {
      bytes = Buffer.concat([bytes, chunk]); const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timer); socket.removeListener('data', received); socket.pause();
      assert.equal(bytes.subarray(0, end + 4).toString(), 'HTTP/1.1 200 Connection Established\r\n\r\n');
      if (bytes.length > end + 4) socket.unshift(bytes.subarray(end + 4)); resolve(socket);
    }
    socket.on('data', received);
  });
  socket.write(header); return ready;
}
async function waitFor(read, expected) {
  const end = performance.now() + 2500;
  while (!expected(read())) { if (performance.now() >= end) throw Error('test_state_timeout'); await delay(10); }
}

test('typed bounded run config rejects expiry, malformed keys and target overrides', () => {
  const value = config(18444); const parse = input => parseRelayConfig(Buffer.from(JSON.stringify(input)));
  assert.equal(parse(value).listenPort, 18444);
  for (const changes of [{ listenPort: 0 }, { listenPort: 65536 }, { listenPort: true }, { version: 2 },
    { runId: value.runId.toUpperCase() }, { hardwareUUIDSHA256: 'invalid' }, { host: 'elsewhere.invalid' },
    { expiresAtUnixSeconds: value.issuedAtUnixSeconds + 3601 }, { issuedAtUnixSeconds: value.expiresAtUnixSeconds },
    { expiresAtUnixSeconds: Math.floor(Date.now() / 1000) - 1 }]) assert.throws(() => parse({ ...value, ...changes }));
  assert.throws(() => parseRelayConfig(Buffer.alloc(2049)));
  assert.throws(() => parseRelayConfig(Buffer.from('null')));
});

test('CONNECT parser refuses alternate authority, auth, duplicate headers, folding and bodies', () => {
  assert.equal(parseConnectHeader(header), TARGET_AUTHORITY);
  const text = header.toString();
  for (const invalid of [text.replace('CONNECT ', 'GET '), text.replace(TARGET_HOST, 'elsewhere.invalid'),
    text.replace(':443 HTTP', ':444 HTTP'), text.replace('HTTP/1.1', 'HTTP/1.0'),
    text.replace('Host:', ' Host:'), text.replace('\r\n\r\n', '\r\nHost: duplicate\r\n\r\n'),
    text.replace('\r\n\r\n', '\r\nProxy-Authorization: synthetic-unused\r\n\r\n'),
    text.replace('\r\n\r\n', '\r\nContent-Length: 1\r\n\r\n'), text.replace('keep-alive', 'upgrade'),
    text.replace('\r\n\r\n', '\n\n'), text.replace('Host:', '\u0000Host:')])
    assert.throws(() => parseConnectHeader(Buffer.from(invalid)));
});

test('fragmented CONNECT waits for complete validated header; opaque bytes pass unchanged', { timeout: 5000 }, async t => {
  const { relay, calls } = await fixture(t), socket = await client(t, relay);
  socket.write(header.subarray(0, 20)); await delay(20); assert.equal(calls(), 0);
  const response = once(socket, 'data'); socket.write(header.subarray(20));
  assert.equal((await response)[0].toString(), 'HTTP/1.1 200 Connection Established\r\n\r\n');
  const opaque = Buffer.from([0, 255, 23, 42, 0, 9]); const echoed = once(socket, 'data'); socket.write(opaque);
  assert.deepEqual((await echoed)[0], opaque); assert.equal(calls(), 1);
  assert.equal(relay.snapshot().counters.clientBytes, opaque.length);
  assert.equal(JSON.stringify(relay.snapshot()).includes('synthetic-unused'), false);
  socket.destroy(); await waitFor(relay.snapshot, state => state.activeConnections === 0);
});

test('invalid CONNECT closes without dialing any upstream', { timeout: 5000 }, async t => {
  const { relay, calls } = await fixture(t), socket = await client(t, relay);
  const closed = once(socket, 'close'); socket.write(header.toString().replace(TARGET_HOST, 'unapproved.invalid'));
  await closed; assert.equal(calls(), 0); assert.equal(relay.snapshot().counters.rejected, 1);
});

test('optimistic bytes after CONNECT are forwarded once without becoming headers', { timeout: 5000 }, async t => {
  const { relay } = await fixture(t), socket = await client(t, relay);
  const opaque = Buffer.from([23, 3, 3, 0, 2, 91, 92]); let received = Buffer.alloc(0);
  socket.on('data', bytes => { received = Buffer.concat([received, bytes]); });
  socket.write(Buffer.concat([header, opaque]));
  const response = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');
  await waitFor(() => received, bytes => bytes.length >= response.length + opaque.length);
  assert.deepEqual(received, Buffer.concat([response, opaque]));
  assert.equal(relay.snapshot().counters.clientBytes, opaque.length); socket.destroy();
});

test('header size and stalled header have independent bounds', { timeout: 5000 }, async t => {
  const { relay, calls } = await fixture(t, { limits: { ...LIMITS, headerBytes: 64, headerMs: 40 } });
  const a = await client(t, relay), closedA = once(a, 'close'); a.write(Buffer.alloc(65, 65)); await closedA;
  const b = await client(t, relay), closedB = once(b, 'close'); b.write('CONNECT '); await closedB;
  const c = await client(t, relay), closedC = once(c, 'close'); c.write(header); await closedC;
  assert.equal(calls(), 0); assert.equal(relay.snapshot().counters.rejected, 3);
});

test('concurrent socket limit rejects extra connection and preserves existing tunnel', { timeout: 5000 }, async t => {
  const { relay } = await fixture(t, { limits: { ...LIMITS, connections: 1, drainMs: 50 } });
  const a = await tunnel(t, relay); a.resume(); const b = await client(t, relay); await once(b, 'close');
  assert.equal(relay.snapshot().activeConnections, 1);
  const echoed = once(a, 'data'); a.write('lab'); assert.equal((await echoed)[0].toString(), 'lab'); a.destroy();
});

test('unavailable upstream fails once without direct retry or fallback', { timeout: 5000 }, async t => {
  const unused = await port(); let calls = 0;
  const relay = await createRelay(config(await port()), { dial: (host, remotePort) => {
    assert.equal(host, TARGET_HOST); assert.equal(remotePort, 443); calls++;
    return net.connect({ host: '127.0.0.1', port: unused });
  } }); t.after(() => relay.stop());
  const socket = await client(t, relay), closed = once(socket, 'close'); socket.write(header); await closed;
  assert.equal(calls, 1); assert.equal(relay.snapshot().counters.connected, 0);
});

test('continuous deadline expires despite wall rollback; active exchange drains then closes', { timeout: 5000 }, async t => {
  let mono = 0; const wall = Date.now();
  const { relay } = await fixture(t, { wallNow: () => wall, monotonicNow: () => mono,
    limits: { ...LIMITS, drainMs: 500 } });
  const socket = await tunnel(t, relay); socket.resume(); mono = 61000;
  await waitFor(relay.snapshot, state => state.state === 'DRAINING');
  const echoed = once(socket, 'data'); socket.write('still-in-flight');
  assert.equal((await echoed)[0].toString(), 'still-in-flight'); socket.destroy();
  const done = await relay.done; assert.equal(done.state, 'CLOSED'); assert.equal(done.activeConnections, 0);
  assert.equal(done.reason, 'scope_expired'); assert.equal(done.nativeRecordingStopped, 'NOT_ESTABLISHED');
});

test('operator stop waits for actual socket close, with finite drain grace', { timeout: 5000 }, async t => {
  const { relay } = await fixture(t, { limits: { ...LIMITS, drainMs: 60 } });
  const socket = await tunnel(t, relay), closed = once(socket, 'close'); socket.resume();
  const pending = relay.stop(); assert.equal(relay.snapshot().state, 'DRAINING');
  const done = await pending; await closed; assert.equal(done.activeConnections, 0);
  assert.ok(done.counters.resourceClosed >= 1); assert.equal(relay.snapshot().state, 'CLOSED');
});

test('occupied listener is not replaced', { timeout: 5000 }, async t => {
  const occupied = await server(t, net.createServer(socket => socket.destroy()));
  await assert.rejects(createRelay(config(occupied), { dial: () => assert.fail('no dial') }), /relay_bind_failed/);
});

test('byte budget closes only owned sockets and reports resource exhaustion', { timeout: 5000 }, async t => {
  const { relay } = await fixture(t, { limits: { ...LIMITS, connectionBytes: 8, drainMs: 50 } });
  const socket = await tunnel(t, relay), closed = once(socket, 'close'); socket.resume(); socket.write(Buffer.alloc(9));
  await closed; await waitFor(relay.snapshot, state => state.activeConnections === 0);
  assert.ok(relay.snapshot().counters.resourceClosed >= 1); assert.equal(relay.snapshot().state, 'LISTENING');
});

test('idle tunnel is bounded independently of full run expiry', { timeout: 5000 }, async t => {
  const { relay } = await fixture(t, { limits: { ...LIMITS, idleMs: 50, drainMs: 50 } });
  const socket = await tunnel(t, relay), closed = once(socket, 'close'); socket.resume(); await closed;
  assert.ok(relay.snapshot().counters.idleClosed >= 1);
});

test('aggregate byte exhaustion stops accepting new work', { timeout: 5000 }, async t => {
  const { relay } = await fixture(t, { limits: { ...LIMITS, totalBytes: 8, drainMs: 50 } });
  const socket = await tunnel(t, relay); socket.resume(); socket.write(Buffer.alloc(5));
  const done = await relay.done;
  assert.equal(done.reason, 'resource_limit'); assert.equal(done.activeConnections, 0);
});

test('simultaneous connection and aggregate exhaustion still drains the whole run', { timeout: 5000 }, async t => {
  const upstreamPort = await server(t, net.createServer(socket => socket.on('data', () => {})));
  const relay = await createRelay(config(await port()), {
    limits: { ...LIMITS, connectionBytes: 10, totalBytes: 20, drainMs: 100 },
    dial: () => net.connect({ host: '127.0.0.1', port: upstreamPort }),
  });
  t.after(() => relay.stop());
  const a = await tunnel(t, relay), b = await tunnel(t, relay); a.resume(); b.resume();
  a.write(Buffer.alloc(10)); b.write(Buffer.alloc(10));
  await waitFor(relay.snapshot, value => value.counters.clientBytes === 20);
  a.write(Buffer.alloc(1));
  await waitFor(relay.snapshot, value => value.reason === 'resource_limit');
  assert.notEqual(relay.snapshot().state, 'LISTENING');
  const done = await relay.done; assert.equal(done.activeConnections, 0);
  assert.equal(done.counters.clientBytes, 21);
});

test('accepted connection budget initiates bounded draining', { timeout: 5000 }, async t => {
  const { relay, calls } = await fixture(t, { limits: { ...LIMITS, acceptedConnections: 1, drainMs: 50 } });
  await client(t, relay); const b = await client(t, relay); await once(b, 'close');
  const done = await relay.done;
  assert.equal(done.reason, 'resource_limit'); assert.equal(done.counters.accepted, 1);
  assert.equal(done.activeConnections, 0); assert.equal(calls(), 0);
});

test('actual loopback TLS remains end-to-end and hostname validation still rejects mismatch', { timeout: 15000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'scribe-relay-tls-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'openssl.cnf'), `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=scribe-relay-fixture.invalid\n[extensions]\nsubjectAltName=DNS:${TARGET_HOST}\nbasicConstraints=critical,CA:TRUE\n`);
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', join(folder, 'openssl.cnf'),
    '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem')], { stdio: 'ignore', timeout: 10000 });
  const key = await readFile(join(folder, 'key.pem')), cert = await readFile(join(folder, 'cert.pem'));
  const upstream = tls.createServer({ key, cert }, socket => { socket.on('error', () => {}); socket.pipe(socket); });
  upstream.on('tlsClientError', () => {}); const upstreamPort = await server(t, upstream);
  const relay = await createRelay(config(await port()), { dial: () => net.connect({ host: '127.0.0.1', port: upstreamPort }) });
  t.after(() => relay.stop());
  const raw = await tunnel(t, relay), secure = tls.connect({ socket: raw, ca: cert, servername: TARGET_HOST });
  secure.on('error', () => {}); t.after(() => secure.destroy()); await once(secure, 'secureConnect');
  assert.equal(secure.authorized, true); const echoed = once(secure, 'data'); secure.write('synthetic TLS payload');
  assert.equal((await echoed)[0].toString(), 'synthetic TLS payload'); secure.destroy();
  const badRaw = await tunnel(t, relay), wrongName = tls.connect({ socket: badRaw, ca: cert, servername: 'wrong.invalid' });
  t.after(() => wrongName.destroy()); const [error] = await once(wrongName, 'error');
  assert.equal(error.code, 'ERR_TLS_CERT_ALTNAME_INVALID'); wrongName.destroy();
  assert.equal(relay.snapshot().tlsInspection, false);
});
