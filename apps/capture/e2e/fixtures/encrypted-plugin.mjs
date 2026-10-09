/* global indexedDB */
// Test-only WebCrypto storage models the plugin's revision contract. This is not
// evidence of physical-device Keychain custody or a packaged native plugin.
export async function encryptedFixturePlugin(name) {
  const opening = indexedDB.open(`provider-fixture-${name}`, 1);
  opening.onupgradeneeded = () => { opening.result.createObjectStore("records"); opening.result.createObjectStore("keys"); };
  const db = await result(opening);
  let key = await result(db.transaction("keys").objectStore("keys").get("key"));
  if (!key) {
    key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").put(key, "key"); await done(tx);
  }
  async function get({ key: id }) {
    const row = await result(db.transaction("records").objectStore("records").get(id));
    if (!row) throw Object.assign(new Error("missing"), { code: "SECURE_QUEUE_NOT_FOUND" });
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: row.iv, additionalData: new TextEncoder().encode(id) }, key, row.bytes);
    return { key: id, data: new TextDecoder().decode(bytes), revision: row.revision };
  }
  async function write({ key: id, data, expectedRevision = null }) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, key, new TextEncoder().encode(data));
    const tx = db.transaction("records", "readwrite"), store = tx.objectStore("records"), complete = done(tx);
    const previous = await result(store.get(id));
    if ((previous?.revision ?? null) !== expectedRevision) { tx.abort(); await complete.catch(() => {}); throw new Error("revision conflict"); }
    const revision = String(Number(expectedRevision ?? 0) + 1);
    store.put({ iv, bytes, revision }, id); await complete; return { revision };
  }
  return { get, create: write, compareAndSwap: write };
}
function result(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function done(tx) { return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); }); }
