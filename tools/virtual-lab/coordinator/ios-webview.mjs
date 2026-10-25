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
// Recheck after switching, before observer installation, reads, or uninstall.
// Return only a boolean: hosted login URLs and credentials never enter receipts.
export const IOS_CONTEXT_ATTESTATION = `const url = new URL(window.location.href);
return url.protocol === 'capacitor:' && url.hostname === 'localhost' && url.port === ''
  && url.username === '' && url.password === ''
  && (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === ''
  && typeof window.Capacitor?.nativePromise === 'function'
  && typeof window.Capacitor?.fromNative === 'function';`;
