import { setTimeout as delay } from 'node:timers/promises';

const fail = () => { throw Error('owned_webview_ambiguous'); };
const localRoot = value => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'capacitor:' && url.hostname === 'localhost' && !url.port
      && !url.username && !url.password && ['', '/'].includes(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
};

/** XCUITest's fresh mobile:getContexts metadata distinguishes the app from the
 * SafariViewService that can remain after hosted sign-in. Never cache a PID,
 * pick the first page, or use a page title as ownership evidence. */
export function selectOwnedIOSWebview(contexts, bundleId) {
  if (typeof bundleId !== 'string' || !/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+$/.test(bundleId)
      || !Array.isArray(contexts) || contexts.length < 2 || contexts.length > 64) fail();
  const ids = new Set(), matches = [];
  let native = 0;
  for (const context of contexts) {
    if (!context || typeof context !== 'object' || typeof context.id !== 'string' || ids.has(context.id)) fail();
    ids.add(context.id);
    if (context.id === 'NATIVE_APP') { native++; continue; }
    if (!/^WEBVIEW_[0-9]+\.[0-9]+$/.test(context.id)
        || typeof context.bundleId !== 'string' || !context.bundleId
        || typeof context.url !== 'string' || !context.url) fail();
    if (context.bundleId === bundleId && localRoot(context.url)) matches.push(context.id);
  }
  if (native !== 1 || matches.length !== 1) fail();
  return matches[0];
}

export const IOS_CONTEXT_DISCOVERY = Object.freeze({ script: 'mobile: getContexts', args: [{ waitForWebviewMs: 0 }] });
export const IOS_CONTEXT_READINESS_MS = 1500;

/** Only the observed, exact native-only startup response is retryable. Each
 * request remains read-only and uses the caller's abort/deadline. This wait is
 * inside (never added after) the existing 2s native/input proof budget. */
export async function discoverOwnedIOSWebview(readContexts, bundleId, signal) {
  if (typeof readContexts !== 'function' || typeof bundleId !== 'string'
      || !/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+$/.test(bundleId)) fail();
  const active = AbortSignal.any([AbortSignal.timeout(IOS_CONTEXT_READINESS_MS), ...(signal ? [signal] : [])]);
  try {
    for (;;) {
      active.throwIfAborted();
      const contexts = await readContexts(active);
      active.throwIfAborted(); // A late response cannot establish readiness.
      const nativeOnly = Array.isArray(contexts) && contexts.length === 1
        && contexts[0] && typeof contexts[0] === 'object' && !Array.isArray(contexts[0])
        && Object.keys(contexts[0]).length === 1 && contexts[0].id === 'NATIVE_APP';
      if (!nativeOnly) return selectOwnedIOSWebview(contexts, bundleId);
      await delay(100, undefined, { signal: active });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (active.aborted) throw Error('owned_webview_not_ready');
    throw error;
  }
}
// Recheck after switching, before observer installation, reads, or uninstall.
// Return only a boolean: hosted login URLs and credentials never enter receipts.
export const IOS_CONTEXT_ATTESTATION = `const url = new URL(window.location.href);
return url.protocol === 'capacitor:' && url.hostname === 'localhost' && url.port === ''
  && url.username === '' && url.password === ''
  && (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === ''
  && typeof window.Capacitor?.nativePromise === 'function'
  && typeof window.Capacitor?.fromNative === 'function';`;
