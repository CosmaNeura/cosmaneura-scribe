import assert from 'node:assert/strict';
import test from 'node:test';
import { LatestReply, waitForLatestZoomReply } from './zoom-bot-ui.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 30));

test('overlapping Schedule responses wait for the newest body, rejecting older completion', async () => {
  const reader = new LatestReply(), signal = new AbortController().signal;
  const first = reader.begin();
  reader.finish(first, { meeting: 'old' });
  const newest = reader.begin();
  // This is the live failure condition: the first response arrived, but the
  // current body has not settled when the normal Schedule flow reads it.
  assert.equal(reader.value, null);
  let settled = false;
  const pending = waitForLatestZoomReply(reader, { signal, timeoutMs: 1000 }).then(value => { settled = true; return value; });
  reader.finish(first, { meeting: 'stale late body' });
  await tick(); assert.equal(settled, false);
  const current = { meeting: 'current' };
  reader.finish(newest, current);
  assert.equal(await pending, current);
});

test('a further request invalidates the awaited generation and its late body', async () => {
  const reader = new LatestReply(), signal = new AbortController().signal;
  const first = reader.begin();
  const pending = waitForLatestZoomReply(reader, { signal, timeoutMs: 1000 });
  const second = reader.begin();
  reader.finish(first, { meeting: 'stale' });
  assert.equal(reader.value, null);
  reader.finish(second, { failureCode: 'zoom_normal_response_failed' });
  assert.deepEqual(await pending, { failureCode: 'zoom_normal_response_failed' });
});

test('missing newest body times out without falling back to the prior valid meeting', async () => {
  const reader = new LatestReply();
  reader.finish(reader.begin(), { meeting: 'previous' }); reader.begin();
  await assert.rejects(waitForLatestZoomReply(reader, { signal: new AbortController().signal, timeoutMs: 30 }), /zoom_latest_response_not_settled/);
  assert.equal(reader.value, null);
});

test('cancellation ends response waiting and refuses a later valid body', async () => {
  const reader = new LatestReply(), controller = new AbortController(), generation = reader.begin();
  const pending = waitForLatestZoomReply(reader, { signal: controller.signal, timeoutMs: 30000 });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  reader.finish(generation, { meeting: 'late' });
  await assert.rejects(waitForLatestZoomReply(reader, { signal: controller.signal, timeoutMs: 1000 }), { name: 'AbortError' });
});

test('only bounded waits with a cancellation signal are accepted', async () => {
  for (const options of [{ timeoutMs: 1 }, { signal: new AbortController().signal, timeoutMs: 0 },
    { signal: new AbortController().signal, timeoutMs: 30001 }]) {
    await assert.rejects(waitForLatestZoomReply(new LatestReply(), options), /zoom_response_wait_invalid/);
  }
});
