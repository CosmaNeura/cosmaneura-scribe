// Actual compiled provider UI, invented note/transcript, isolated browser. No services or media.
/* global window, document, scrollX, scrollY, innerWidth */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [bundleDirectory, playwrightModule, outputDirectory] = process.argv.slice(2);
if (!bundleDirectory || !playwrightModule || !outputDirectory) throw new Error("Usage: check-note-comparison-layout.mjs provider-directory playwright-module output-directory");
const { chromium, expect } = await import(pathToFileURL(resolve(playwrightModule)));
const out = resolve(outputDirectory), origin = "https://scribe-comparison.invalid";
await mkdir(out, { recursive: true });
const files = new Map([
  ["/provider.js", ["text/javascript", await readFile(join(bundleDirectory, "provider-capture.js"))]],
  ["/provider.css", ["text/css", await readFile(join(bundleDirectory, "provider-capture.css"))]],
  ["/fixture.mjs", ["text/javascript", await readFile(new URL("fixtures/note-source-matches.mjs", import.meta.url))]],
  ["/", ["text/html", '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/provider.css"><style>body{margin:0;background:white}</style></head><body><main id="root"></main><script type="module" src="/start.mjs"></script></body></html>']],
  ["/start.mjs", ["text/javascript", `
    import { mountProviderWorkspace } from "/provider.js";
    import { sourceMatchFixture } from "/fixture.mjs";
    const f = await sourceMatchFixture(), abort = new AbortController();
    const journal = { revision: "1", progress: { admission: null, sessionId: f.session, uploaded: true, pendingSave: null } };
    const stats = { reads: 0, writes: 0, forbidden: 0 };
    const forbidden = () => { stats.forbidden++; throw new Error("Unexpected service, media or save"); };
    const selected = { scope: f.scope, encounter: f.encounter, signal: abort.signal, noteOpeningSupported: true,
      recorder: forbidden, openInCore: forbidden,
      journal: { load: async () => journal, save: forbidden },
      reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }),
      request: async (path, body) => {
        if (!path.endsWith("/note-opening")) return forbidden(); stats.reads++;
        return Response.json({ contract_version: "1", workspace_id: f.scope.workspaceId, binding_ref: f.scope.bindingRef,
          request_nonce: body.request_nonce, checked_at: new Date().toISOString(), operation: "note_opening",
          receipt: { session_id: f.session, review: f.review, templates: [f.template], note: f.note } });
      } };
    mountProviderWorkspace(document.querySelector("#root"), { signal: abort.signal,
      listEncounters: async () => [f.encounter], createEncounter: forbidden,
      openEncounter: async () => ({ ...selected, openingReview: { scope: f.scope, receivedAt: Date.now(), view: f.review } }) });
    window.lab = { stats, targetId: f.review.source.segments.at(-1).source_segment_id, journal: () => JSON.stringify(journal) };
  `]],
]);
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const observations = [];
try {
  for (const [width, height] of [[390, 844], [780, 844], [1280, 844], [1280, 600]]) {
    const context = await browser.newContext({ viewport: { width, height } }), blocked = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url()), entry = files.get(url.pathname);
      if (url.origin !== origin || !entry) { blocked.push(url.href); return route.abort(); }
      return route.fulfill({ body: entry[1], contentType: entry[0] });
    });
    await context.addInitScript(() => {
      window.mediaCalls = 0;
      for (const method of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices ?? {}, method,
        { value: () => { window.mediaCalls++; throw new Error("No media in this fixture"); } });
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(origin);
      await page.locator('[data-workspace-action="open"]').click();
      await page.locator('[data-review-action="continue"]').click();
      const links = page.locator("[data-note-source-match]"), fields = page.locator("[data-note-field]");
      await expect(links).toHaveCount(2); await expect(fields).toHaveCount(3);
      const assessment = fields.nth(1), plan = fields.nth(2), link = links.nth(1);
      await assessment.fill(Array(20).fill("Unsaved synthetic assessment wording retained.").join("\n"));
      await link.scrollIntoViewIfNeeded();
      await assessment.evaluate(field => {
        field.focus({ preventScroll: true }); field.setSelectionRange(4, 16, "backward"); field.scrollTop = 31;
        const scrolls = []; for (let element = field; element; element = element.parentElement) scrolls.push({ element, top: element.scrollTop, left: element.scrollLeft });
        window.before = { field, fields: [...document.querySelectorAll("[data-note-field]")], value: field.value, baseline: field.defaultValue,
          selection: [field.selectionStart, field.selectionEnd, field.selectionDirection], scrolls, x: scrollX, y: scrollY, journal: window.lab.journal() };
      });
      await page.screenshot({ path: join(out, `note-${width}x${height}.png`) });
      await page.locator("[data-transcript-search]").evaluate(input => { input.value = "absent phrase"; input.dispatchEvent(new Event("input", { bubbles: true })); });
      await link.click();
      const target = page.locator(`[data-transcript-segment="${await page.evaluate(() => window.lab.targetId)}"]`);
      const back = page.locator("[data-note-source-back]"), pane = page.locator("[data-note-transcript-scroll]");
      await expect(target).toBeFocused(); await expect(target).toHaveAttribute("data-search-current", "true");
      await expect(page.locator("[data-transcript-search]")).toHaveValue(""); await expect(back).toBeVisible();
      const rowBox = await target.boundingBox(), backBox = await back.boundingBox(), paneBox = await pane.boundingBox(), planBox = await plan.boundingBox();
      assert.ok(rowBox && backBox && paneBox);
      assert.ok(rowBox.y >= paneBox.y && rowBox.y + rowBox.height <= paneBox.y + paneBox.height + 1, "Matched row must be fully inside the transcript viewport");
      assert.ok(backBox.y >= 0 && backBox.y + backBox.height <= height && backBox.height >= 44, "Back control must fit the screen");
      assert.ok(backBox.y + backBox.height <= paneBox.y, "Back toolbar must not overlay any transcript text");
      if (width >= 900) {
        assert.ok(planBox && planBox.y >= 0 && planBox.y + planBox.height <= height, "Matching note field must remain fully onscreen beside transcript");
        assert.ok(planBox.x + planBox.width <= paneBox.x, "Note must remain beside transcript");
      } else { await expect(assessment).toBeHidden(); await expect(page.locator('[data-workspace-action="transcript-view"]')).toHaveAttribute("aria-pressed", "true"); }
      await page.screenshot({ path: join(out, `comparison-${width}x${height}.png`) });
      await back.click(); await expect(assessment).toBeVisible(); await expect(assessment).toBeFocused();
      const restored = await page.evaluate(() => {
        const before = window.before, now = [...document.querySelectorAll("[data-note-field]")], field = before.field;
        return { sameNodes: now.every((element, i) => element === before.fields[i]), valueUnchanged: field.value === before.value,
          defaultUnchanged: field.defaultValue === before.baseline, selectionRestored: JSON.stringify([field.selectionStart, field.selectionEnd, field.selectionDirection]) === JSON.stringify(before.selection),
          scrollRestored: Math.abs(scrollX - before.x) < 1 && Math.abs(scrollY - before.y) < 1 && before.scrolls.every(item => Math.abs(item.element.scrollTop - item.top) < 1 && Math.abs(item.element.scrollLeft - item.left) < 1),
          journalUnchanged: window.lab.journal() === before.journal, stats: window.lab.stats,
          overflow: document.documentElement.scrollWidth > innerWidth, mediaCalls: window.mediaCalls };
      });
      for (const flag of ["sameNodes", "valueUnchanged", "defaultUnchanged", "selectionRestored", "scrollRestored", "journalUnchanged"]) assert.equal(restored[flag], true, `${flag} at ${width}x${height}`);
      assert.deepEqual(restored.stats, { reads: 1, writes: 0, forbidden: 0 });
      assert.equal(restored.mediaCalls, 0); assert.equal(restored.overflow, false); assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
      observations.push({ width, height, rowBox, backBox, paneBox, planBox, ...restored });
    } finally { await context.close(); }
  }
  await writeFile(join(out, "LAYOUT_CHECKS.json"), JSON.stringify({ passed: true, synthetic_only: true, actualNativeApp: false, observations }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: true, viewports: observations.length, mediaCalls: 0, actualNativeApp: false }) + "\n");
} finally { await browser.close(); }
