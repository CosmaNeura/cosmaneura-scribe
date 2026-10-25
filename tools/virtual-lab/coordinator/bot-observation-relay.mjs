import http from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {BotCaptureProofGate, BOT_PROOF_MAX_AGE_MS} from '../zoom/bot-capture-proof.mjs';

const now = () => performance.timeOrigin + performance.now();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const need = (value, code) => { if (!value) throw Error(code); };
const equalCapability = (a, b) => typeof a === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Carries only validated observation metadata over a separately owned SSH
 * loopback forward. It cannot bind consent, start/stop a bot, discover IDs, or
 * expose provider credentials. Keep the returned capability in a private file.
 * The receiving source must still time and validate its entire remote request.
 */
export async function createBotObservationRelay({expected, collector, signal}) {
  need(signal instanceof AbortSignal && typeof collector?.observe === 'function'
    && typeof collector?.observeStopped === 'function', 'bot_relay_configuration_invalid');
  signal.throwIfAborted();
  const gate = new BotCaptureProofGate(expected), capability = randomBytes(32).toString('hex');
  const sockets = new Set(), nonces = new Set();
  let busy = false, closed = false, recordingBlocked = false, closePromise, pending = null;
  const reply = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close'});
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    // No proxy headers, redirects, general URL forwarding, or remote listener.
    if (req.socket.remoteAddress !== '127.0.0.1' || req.method !== 'POST' || req.url !== '/'
      || req.headers['content-type'] !== 'application/json') { reply(res, 400, {error: 'bot_relay_request_refused'}); return; }
    let raw = '', timer;
    const started = now();
    try {
      timer = setTimeout(() => req.destroy(), BOT_PROOF_MAX_AGE_MS);
      for await (const chunk of req) {
        raw += chunk.toString('utf8');
        need(Buffer.byteLength(raw) <= 1024, 'bot_relay_request_refused');
      }
      const request = JSON.parse(raw);
      need(keys(request, ['version', 'runId', 'action', 'requestNonce', 'capability'])
        && request.version === 1 && request.runId === expected.runId && uuid(request.requestNonce)
        && ['observe', 'observeStopped'].includes(request.action)
        && equalCapability(request.capability, capability), 'bot_relay_request_refused');
      need(!closed && (!recordingBlocked || request.action === 'observeStopped')
        && !busy && !nonces.has(request.requestNonce) && nonces.size < 4096,
        'bot_relay_unavailable');
      busy = true; nonces.add(request.requestNonce);
      clearTimeout(timer);
      let deadline;
      try {
        const operation = Promise.resolve().then(() => collector[request.action]({requestNonce: request.requestNonce}));
        // Do not retry or release the busy lane if its collector is still live.
        const settlement = operation.then(() => {}, () => {}).then(() => {
          busy = false; if (pending === settlement) pending = null;
        });
        pending = settlement;
        const value = await Promise.race([operation, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(Error('bot_relay_deadline_exceeded')),
            Math.max(1, BOT_PROOF_MAX_AGE_MS - (now() - started)));
        })]);
        need(!closed && !signal.aborted && !res.destroyed, 'bot_relay_closed');
        const received = now();
        gate.validate(value, request.action === 'observe' ? 'recording' : 'stopped', {
          request: {requestNonce: request.requestNonce, sentAtEpochMs: started, receivedAtEpochMs: received}, now: received,
        });
        need(Buffer.byteLength(JSON.stringify(value)) <= 262144, 'bot_relay_response_limit');
        reply(res, 200, value); // Forward the original DTO, without new timestamps.
      } catch {
        recordingBlocked = true; gate.observationFailed();
        reply(res, 503, {error: 'bot_relay_observation_unavailable'});
      } finally {
        clearTimeout(deadline);
      }
    } catch { reply(res, 400, {error: 'bot_relay_request_refused'}); }
    finally { clearTimeout(timer); }
  });
  server.maxHeadersCount = 12;
  server.headersTimeout = 2000;
  server.requestTimeout = 2000;
  server.on('connection', socket => {
    sockets.add(socket); socket.setTimeout(2500, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  const close = () => {
    if (closePromise) return closePromise;
    closed = true; recordingBlocked = true; signal.removeEventListener('abort', abort);
    closePromise = (async () => {
      const ended = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await ended;
      let collectorSettled = !pending, timer;
      if (pending) {
        await Promise.race([pending.then(() => { collectorSettled = true; }),
          new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
        clearTimeout(timer);
      }
      return {relayClosed: true, ownedConnectionsSettled: sockets.size === 0, collectorRequestSettled: collectorSettled};
    })();
    return closePromise;
  };
  const abort = () => { void close(); };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen({host: '127.0.0.1', port: 0, exclusive: true}, resolve);
    });
    signal.addEventListener('abort', abort, {once: true});
    signal.throwIfAborted();
    const address = server.address();
    need(address?.address === '127.0.0.1', 'bot_relay_listener_invalid');
    return Object.freeze({
      endpoint: Object.freeze({version: 1, host: '127.0.0.1', port: address.port, runId: expected.runId, capability}),
      close,
    });
  } catch (error) { await close(); throw error; }
}

/** Connect only to an owned local forward. No external host/URL option exists.
 * A failed request permanently blocks recording observations. A later explicit
 * stop read is still possible; there is no automatic retry or source restart.
 */
export function createBotObservationRelayClient({endpoint, signal}) {
  need(signal instanceof AbortSignal && keys(endpoint, ['version', 'host', 'port', 'runId', 'capability'])
    && endpoint.version === 1 && endpoint.host === '127.0.0.1' && uuid(endpoint.runId)
    && Number.isSafeInteger(endpoint.port) && endpoint.port > 0 && endpoint.port < 65536
    && /^[a-f0-9]{64}$/.test(endpoint.capability), 'bot_relay_endpoint_invalid');
  signal.throwIfAborted();
  let closed = false, busy = false, recordingBlocked = false, active = null;
  const nonces = new Set();
  const close = () => { closed = true; active?.destroy(Error('bot_relay_closed')); signal.removeEventListener('abort', close); };
  signal.addEventListener('abort', close, {once: true});
  const request = async (action, {requestNonce}) => {
    signal.throwIfAborted();
    need(!closed && (!recordingBlocked || action === 'observeStopped') && !busy
      && uuid(requestNonce) && !nonces.has(requestNonce) && nonces.size < 4096, 'bot_relay_client_unavailable');
    nonces.add(requestNonce); busy = true;
    const started = now();
    try {
      const value = await new Promise((resolve, reject) => {
        let bytes = 0, body = '', timer;
        const fail = () => { clearTimeout(timer); reject(Error('bot_relay_observation_unavailable')); };
        active = http.request({host: '127.0.0.1', port: endpoint.port, path: '/', method: 'POST', agent: false,
          headers: {'Content-Type': 'application/json', 'Connection': 'close'}}, response => {
          if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/json') {
            response.destroy(); active.destroy(); fail(); return;
          }
          response.on('error', fail);
          response.on('aborted', fail);
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 262144) { response.destroy(); active.destroy(); fail(); return; }
            body += chunk.toString('utf8');
          });
          response.on('end', () => {
            clearTimeout(timer);
            try { resolve(JSON.parse(body)); } catch { fail(); }
          });
        });
        active.on('error', fail);
        timer = setTimeout(() => { active.destroy(); fail(); }, BOT_PROOF_MAX_AGE_MS);
        active.end(JSON.stringify({version: 1, runId: endpoint.runId, action, requestNonce, capability: endpoint.capability}));
      });
      need(!closed && !signal.aborted && now() - started <= BOT_PROOF_MAX_AGE_MS
        && value?.runId === endpoint.runId && value?.requestNonce === requestNonce, 'bot_relay_response_invalid');
      return value;
    } catch { recordingBlocked = true; active?.destroy(); throw Error('bot_relay_observation_unavailable'); }
    finally { active = null; busy = false; }
  };
  return Object.freeze({observe: fields => request('observe', fields), observeStopped: fields => request('observeStopped', fields), close});
}
