import net from 'node:net';

export const TARGET_HOST = 'cosmaneura-staging-scribe-native.politesmoke-7989878f.northcentralus.azurecontainerapps.io';
export const TARGET_AUTHORITY = `${TARGET_HOST}:443`;
export const LIMITS = Object.freeze({ headerBytes: 16384, headerMs: 5000, connectMs: 10000,
  idleMs: 300000, drainMs: 210000, connections: 16, acceptedConnections: 4096,
  connectionBytes: 1073741824, totalBytes: 4294967296 });
const need = (ok, code) => { if (!ok) throw Error(code); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const seconds = value => Number.isSafeInteger(value) && value > 0 && value <= 4102448400;

export function parseRelayConfig(bytes, at = Date.now()) {
  need(Buffer.isBuffer(bytes) && bytes.length <= 2048, 'relay_config_invalid');
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw Error('relay_config_invalid'); }
  need(value && Object.keys(value).sort().join() === 'expiresAtUnixSeconds,hardwareUUIDSHA256,issuedAtUnixSeconds,listenPort,runId,version'
    && value.version === 1 && uuid(value.runId) && /^[a-f0-9]{64}$/.test(value.hardwareUUIDSHA256 ?? '')
    && Number.isInteger(value.listenPort) && value.listenPort >= 1024 && value.listenPort <= 65535
    && seconds(value.issuedAtUnixSeconds) && seconds(value.expiresAtUnixSeconds)
    && value.expiresAtUnixSeconds > value.issuedAtUnixSeconds
    && value.expiresAtUnixSeconds - value.issuedAtUnixSeconds <= 3600, 'relay_config_invalid');
  need(Number.isFinite(at) && value.issuedAtUnixSeconds * 1000 <= at
    && at < value.expiresAtUnixSeconds * 1000, 'relay_config_expired');
  return Object.freeze(value);
}

/** Only the CONNECT header is interpreted. TLS records are never parsed/logged. */
export function parseConnectHeader(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length <= LIMITS.headerBytes
    && bytes.subarray(-4).equals(Buffer.from('\r\n\r\n'))
    && bytes.every(byte => byte === 9 || byte === 10 || byte === 13 || byte >= 32 && byte <= 126), 'relay_bad_header');
  const lines = bytes.toString('ascii').slice(0, -4).split('\r\n');
  need(lines.shift() === `CONNECT ${TARGET_AUTHORITY} HTTP/1.1`, 'relay_bad_authority');
  const fields = new Map();
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]+):[ \t]*([\x20-\x7e]*)$/.exec(line);
    need(match, 'relay_bad_header');
    const name = match[1].toLowerCase(), value = match[2].trim();
    need(['host', 'connection', 'proxy-connection', 'user-agent'].includes(name)
      && !fields.has(name), 'relay_bad_header');
    if (name === 'host') need(value === TARGET_AUTHORITY, 'relay_bad_authority');
    if (name === 'connection' || name === 'proxy-connection')
      need(['keep-alive', 'close'].includes(value.toLowerCase()), 'relay_bad_header');
    fields.set(name, value);
  }
  need(fields.get('host') === TARGET_AUTHORITY, 'relay_bad_authority');
  return TARGET_AUTHORITY;
}

/** Shared socket engine. The test seam supplies an owned loopback endpoint;
 * production startRelay always supplies the fixed staging TCP dialer below. */
export async function createRelay(config, { dial, limits = LIMITS, wallNow = Date.now,
  monotonicNow = () => performance.now() } = {}) {
  // Revalidate even callers which did not obtain config from the file parser.
  config = parseRelayConfig(Buffer.from(JSON.stringify(config)), wallNow());
  need(typeof dial === 'function', 'relay_dialer_required');
  for (const key of Object.keys(LIMITS))
    need(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= LIMITS[key], 'relay_limit_invalid');
  const initialWall = wallNow(), deadline = monotonicNow() + config.expiresAtUnixSeconds * 1000 - initialWall;
  const current = () => Number.isFinite(wallNow()) && wallNow() >= config.issuedAtUnixSeconds * 1000
    && wallNow() < config.expiresAtUnixSeconds * 1000 && monotonicNow() < deadline;
  const connections = new Set(), counters = { accepted: 0, connected: 0, rejected: 0,
    connectFailed: 0, idleClosed: 0, resourceClosed: 0, clientBytes: 0, serverBytes: 0 };
  let state = 'STARTING', reason = null, listeningClosed = false, drainTimer, expiryTimer, clockTimer;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const snapshot = () => ({ version: 1, runId: config.runId, state, reason,
    activeConnections: connections.size, counters: { ...counters }, targetAuthority: TARGET_AUTHORITY,
    listenAddress: '127.0.0.1', listenPort: config.listenPort,
    tlsInspection: false, nativeRecordingStopped: 'NOT_ESTABLISHED' });
  function settled() {
    if (state !== 'DRAINING' || !listeningClosed || connections.size) return;
    state = 'CLOSED'; clearTimeout(drainTimer); clearTimeout(expiryTimer); clearInterval(clockTimer);
    resolveDone(snapshot());
  }
  function stop(why = 'operator_stop') {
    need(['operator_stop', 'scope_expired', 'resource_limit', 'listener_failed'].includes(why), 'relay_stop_reason');
    if (state === 'CLOSED' || state === 'DRAINING') return done;
    state = 'DRAINING'; reason = why; clearTimeout(expiryTimer); clearInterval(clockTimer);
    server.close(() => { listeningClosed = true; settled(); });
    // Existing TLS exchanges get a bounded grace period. No recorder-stop claim.
    drainTimer = setTimeout(() => {
      for (const connection of connections) { counters.resourceClosed++; connection.close(); }
      settled();
    }, limits.drainMs);
    settled(); return done;
  }
  const server = net.createServer({ allowHalfOpen: false }, client => {
    client.on('error', () => {});
    if (state !== 'LISTENING' || !current() || client.remoteAddress !== '127.0.0.1'
        || connections.size >= limits.connections || counters.accepted >= limits.acceptedConnections) {
      counters.rejected++; client.destroy();
      if (!current()) void stop('scope_expired');
      else if (counters.accepted >= limits.acceptedConnections) void stop('resource_limit');
      return;
    }
    counters.accepted++;
    let upstream, header = Buffer.alloc(0), headerTimer, connectTimer, closed = false, bytes = 0;
    const connection = { close };
    connections.add(connection);
    function close() {
      if (closed) return;
      closed = true; clearTimeout(headerTimer); clearTimeout(connectTimer);
      client.destroy(); upstream?.destroy();
      // A close request is not proof that the sockets have actually closed.
      finishClose();
    }
    let clientClosed = false, upstreamClosed = true;
    function finishClose() {
      if (clientClosed && upstreamClosed) { connections.delete(connection); settled(); }
    }
    client.once('close', () => { clientClosed = true; close(); finishClose(); });
    client.on('error', close);
    client.setTimeout(limits.idleMs, () => { counters.idleClosed++; close(); });
    headerTimer = setTimeout(() => { counters.rejected++; close(); }, limits.headerMs);
    function count(length, side) {
      bytes += length; counters[side] += length;
      if (bytes > limits.connectionBytes) { counters.resourceClosed++; close(); return false; }
      if (counters.clientBytes + counters.serverBytes > limits.totalBytes) {
        counters.resourceClosed++; close(); void stop('resource_limit'); return false;
      }
      return !closed;
    }
    function receive(chunk) {
      if (closed) return;
      const combined = Buffer.concat([header, chunk]), end = combined.indexOf('\r\n\r\n');
      if (end < 0) {
        if (combined.length > limits.headerBytes) { counters.rejected++; close(); }
        else header = combined;
        return;
      }
      clearTimeout(headerTimer); client.pause(); client.removeListener('data', receive);
      if (end + 4 > limits.headerBytes) { counters.rejected++; close(); return; }
      try { parseConnectHeader(combined.subarray(0, end + 4)); }
      catch { counters.rejected++; close(); return; }
      header = null;
      if (!current() || state !== 'LISTENING') { close(); void stop('scope_expired'); return; }
      const head = combined.subarray(end + 4);
      try { upstream = dial(TARGET_HOST, 443); }
      catch { counters.connectFailed++; close(); return; }
      upstreamClosed = false;
      upstream.once('close', () => { upstreamClosed = true; close(); finishClose(); });
      upstream.on('error', () => { counters.connectFailed++; close(); });
      upstream.setTimeout(limits.idleMs, () => { counters.idleClosed++; close(); });
      connectTimer = setTimeout(() => { counters.connectFailed++; close(); }, limits.connectMs);
      upstream.once('connect', () => {
        clearTimeout(connectTimer);
        if (closed) return;
        if (!current() || state !== 'LISTENING') { close(); void stop('scope_expired'); return; }
        counters.connected++;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // pipe handles backpressure; bounded counters never retain TLS records.
        client.on('data', chunk => { count(chunk.length, 'clientBytes'); });
        upstream.on('data', chunk => { count(chunk.length, 'serverBytes'); });
        if (head.length && !count(head.length, 'clientBytes')) return;
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      });
    }
    client.on('data', receive);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: config.listenPort, exclusive: true }, () => {
        server.removeListener('error', reject); resolve();
      });
    });
  } catch { state = 'CLOSED'; throw Error('relay_bind_failed'); }
  const address = server.address();
  need(address?.address === '127.0.0.1' && address.port === config.listenPort, 'relay_listener_identity');
  state = 'LISTENING'; server.on('error', () => { void stop('listener_failed'); });
  expiryTimer = setTimeout(() => { void stop('scope_expired'); }, Math.max(1, deadline - monotonicNow()));
  clockTimer = setInterval(() => { if (!current()) void stop('scope_expired'); }, 250);
  if (!current()) void stop('scope_expired');
  return Object.freeze({ snapshot, stop, done });
}

/** No destination, trust, proxy or TLS options can be supplied by configuration. */
export function startRelay(config) {
  return createRelay(config, { dial: () => net.connect({ host: TARGET_HOST, port: 443 }) });
}
