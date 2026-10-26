/** Executed only in the freshly attested owned WebView. No input, network,
 * observer installation, or raw field text crosses this read-only boundary. */
export async function observeScrollDocument() {
  const viewport = window.visualViewport;
  if (!viewport || !crypto.subtle || !document.scrollingElement) return null;
  const editable = 'input,textarea,select,[contenteditable]', interactive = `${editable},button,a,label,[role="button"],[tabindex],[data-workspace-action],[data-action]`;
  const fields = [...document.querySelectorAll(editable)];
  if (fields.length > 200) return null;
  const values = fields.map(node => [node.tagName, node.getAttribute('type'), node.id,
    node.getAttribute('name'), node.getAttribute('data-note-field'),
    'value' in node ? node.value : node.textContent, node.hasAttribute('readonly'), node.hasAttribute('disabled')]);
  const serialized = JSON.stringify(values);
  if (serialized.length > 1000000) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  const fieldSHA256 = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  // A changed value during asynchronous hashing cannot qualify a stale snapshot.
  const nowValues = fields.map(node => [node.tagName, node.getAttribute('type'), node.id,
    node.getAttribute('name'), node.getAttribute('data-note-field'),
    'value' in node ? node.value : node.textContent, node.hasAttribute('readonly'), node.hasAttribute('disabled')]);
  if (JSON.stringify(nowValues) !== serialized || fields.some(node => !node.isConnected)
      || document.querySelectorAll(editable).length !== fields.length) return null;
  const width = innerWidth, height = innerHeight, top = Math.ceil(height * 0.28), bottom = Math.floor(height * 0.72);
  const boxes = [...document.querySelectorAll(interactive)].map(node => node.getBoundingClientRect());
  const margins = [8, width - 8].filter(x => {
    // Geometry covers controls narrower than the hit-test sampling interval.
    if (boxes.some(r => r.width > 0 && r.height > 0 && x >= r.left - 3 && x <= r.right + 3
        && bottom >= r.top - 3 && top <= r.bottom + 3)) return false;
    for (let y = top; y <= bottom; y += 8) {
      const node = document.elementFromPoint(x, y);
      if (!node || node.closest(interactive)) return false;
    }
    return true;
  });
  return { version: 1, timeOriginMs: performance.timeOrigin, observedAtMs: performance.now(),
    viewport: { width, height, visualWidth: viewport.width, visualHeight: viewport.height,
      scale: viewport.scale, offsetLeft: viewport.offsetLeft, offsetTop: viewport.offsetTop },
    focusedEditing: Boolean(document.activeElement?.closest(editable)), fieldCount: fields.length, fieldSHA256,
    margins, top, bottom };
}

export const SCROLL_DOCUMENT_SCRIPT = `const done = arguments[arguments.length - 1];
(${observeScrollDocument.toString()})().then(done, () => done(null));`;

export function validateScrollSnapshot(value, frame) {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  if (!value || value.version !== 1 || !finite(value.timeOriginMs) || !finite(value.observedAtMs)
      || typeof value.focusedEditing !== 'boolean' || !Number.isInteger(value.fieldCount)
      || value.fieldCount < 0 || value.fieldCount > 200 || !/^[a-f0-9]{64}$/.test(value.fieldSHA256 ?? '')
      || !frame || !['x', 'y', 'width', 'height'].every(k => finite(frame[k]))
      || frame.x !== 0 || frame.y !== 0 || frame.width < 200 || frame.width > 3000 || frame.height < 200 || frame.height > 3000)
    throw Error('native_scroll_geometry_unconfirmed');
  const v = value.viewport;
  if (!v || !['width', 'height', 'visualWidth', 'visualHeight', 'scale', 'offsetLeft', 'offsetTop'].every(k => finite(v[k]))
      || Math.abs(v.width - frame.width) > 1 || Math.abs(v.height - frame.height) > 1
      || Math.abs(v.visualWidth - v.width) > 1 || Math.abs(v.visualHeight - v.height) > 1
      || v.scale !== 1 || v.offsetLeft !== 0 || v.offsetTop !== 0
      || value.top !== Math.ceil(v.height * 0.28) || value.bottom !== Math.floor(v.height * 0.72)
      || !Array.isArray(value.margins) || value.margins.length > 2 || new Set(value.margins).size !== value.margins.length
      || value.margins.some(x => x !== 8 && x !== v.width - 8)) throw Error('native_scroll_geometry_unconfirmed');
  if (value.focusedEditing) throw Error('native_scroll_editor_focused');
  if (!value.margins.length) throw Error('native_scroll_clear_margin_missing');
  // Return an explicit metadata-only projection, not arbitrary renderer fields.
  return { version: 1, timeOriginMs: value.timeOriginMs, observedAtMs: value.observedAtMs,
    viewport: Object.fromEntries(['width', 'height', 'visualWidth', 'visualHeight', 'scale', 'offsetLeft', 'offsetTop'].map(k => [k, v[k]])),
    focusedEditing: false, fieldCount: value.fieldCount, fieldSHA256: value.fieldSHA256,
    margins: [...value.margins], top: value.top, bottom: value.bottom };
}

export function scrollTouchActions(snapshot, direction) {
  if (!['up', 'down'].includes(direction)) throw Error('native_scroll_arguments_invalid');
  const x = snapshot.margins[0], start = direction === 'down' ? snapshot.bottom : snapshot.top,
    end = direction === 'down' ? snapshot.top : snapshot.bottom;
  return { actions: [{ type: 'pointer', id: 'owned-scroll-touch', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, origin: 'viewport', x, y: start },
    { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 20 },
    { type: 'pointerMove', duration: 350, origin: 'viewport', x, y: end }, { type: 'pointerUp', button: 0 },
  ] }] };
}

export function unchangedScrollFields(before, after) {
  if (before.timeOriginMs !== after.timeOriginMs || JSON.stringify(before.viewport) !== JSON.stringify(after.viewport)
      || after.observedAtMs < before.observedAtMs || before.fieldCount !== after.fieldCount
      || before.fieldSHA256 !== after.fieldSHA256) throw Error('native_scroll_document_changed');
}
