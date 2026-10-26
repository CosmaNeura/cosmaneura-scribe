import assert from 'node:assert/strict';
import test from 'node:test';
import { validateScrollSnapshot, scrollTouchActions, unchangedScrollFields } from './safe-scroll.mjs';

export const frame = { x: 0, y: 0, width: 402, height: 874 };
export const snapshot = () => ({ version: 1, timeOriginMs: 1000, observedAtMs: 20,
  viewport: { width: 402, height: 874, visualWidth: 402, visualHeight: 874, scale: 1, offsetLeft: 0, offsetTop: 0 },
  focusedEditing: false, fieldCount: 4, fieldSHA256: 'a'.repeat(64), margins: [8, 394], top: 245, bottom: 629 });

test('observed editor/keyboard hit is avoided by short margin touch and no keyboard actions', () => {
  const before = validateScrollSnapshot(snapshot(), frame), body = scrollTouchActions(before, 'down');
  const actions = body.actions[0].actions;
  // Real failure: application-default WDA scrolling pressed (.25,.75) for500ms.
  assert(402 * .25 >= 33 && 402 * .25 <= 369 && 874 * .75 >= 589 && 874 * .75 <= 716);
  assert.deepEqual(actions.filter(a => a.type === 'pointerMove').map(a => [a.x, a.y]), [[8, 629], [8, 245]]);
  assert(actions.filter(a => a.type === 'pause').every(a => a.duration <= 20));
  assert.deepEqual(body.actions.map(a => a.type), ['pointer']);
  assert.deepEqual(scrollTouchActions(before, 'up').actions[0].actions.filter(a => a.type === 'pointerMove').map(a => a.y), [245, 629]);
});

test('unknown coordinates, zoom, focus and unsafe margins cannot dispatch a gesture', () => {
  for (const change of [x => { x.focusedEditing = true; }, x => { x.margins = []; },
    x => { x.margins = [100]; }, x => { x.margins = [8, 8]; }, x => { x.viewport.scale = 2; },
    x => { x.viewport.visualHeight = 500; }, x => { x.viewport.offsetTop = 100; },
    x => { x.viewport.width = 401.5 + 1; }, x => { x.fieldSHA256 = 'private text'; },
    x => { x.fieldCount = 201; }, x => { x.top = 0; }, x => { x.timeOriginMs = NaN; }]) {
    const x = snapshot(); change(x); assert.throws(() => validateScrollSnapshot(x, frame), /native_scroll_/);
  }
  assert.throws(() => validateScrollSnapshot(snapshot(), { ...frame, y: 60 }), /geometry_unconfirmed/);
  assert.throws(() => scrollTouchActions(snapshot(), 'left'), /arguments_invalid/);
});

test('post-touch values, reload, viewport and field-count changes are refused without exposing text', () => {
  const before = validateScrollSnapshot(snapshot(), frame);
  for (const change of [x => { x.fieldSHA256 = 'b'.repeat(64); }, x => { x.fieldCount = 5; },
    x => { x.timeOriginMs++; }, x => { x.viewport.height--; }, x => { x.observedAtMs--; }]) {
    const after = structuredClone(before); change(after); assert.throws(() => unchangedScrollFields(before, after), /document_changed/);
  }
  unchangedScrollFields(before, { ...before, observedAtMs: 40 });
  assert.equal(validateScrollSnapshot({ ...snapshot(), privateText: 'do not export' }, frame).privateText, undefined);
});
