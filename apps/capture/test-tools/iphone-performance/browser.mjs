/* global window, document, requestAnimationFrame, innerWidth, innerHeight */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { options, sha256 } from './common.mjs';
const { repo, out, filter } = await options();
const provenance = JSON.parse(await readFile(`${out}/SOURCE.json`, 'utf8'));
assert.equal(await sha256(`${out}/web/lab.js`), provenance.bundleSha256, 'Bundle changed after source inventory');
for (const name of ['lab.js', 'lab.css', 'index.html'])
    assert.equal(await sha256(`${out}/web/${name}`), provenance.assets[name], 'Built asset changed after source inventory');
const require = createRequire(`${repo}/apps/capture/e2e/package.json`);
const { chromium } = require('playwright');
const server = createServer(async (req, res) => {
    try {
        const file = req.url === '/' ? 'index.html' : req.url.slice(1);
        if (!['index.html', 'lab.js', 'lab.css'].includes(file))
            throw Error();
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(await readFile(`${out}/web/${file}`));
    }
    catch {
        res.statusCode = 404;
        res.end();
    }
});
let browser;
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const cases = [
        { name: 'startup-cold', type: 'startup', configuration: 150, application: 250 },
        { name: 'startup-repeat', type: 'startup', configuration: 0, application: 0 },
        { name: 'startup-slow-config', type: 'startup', configuration: 4500, application: 20 },
        { name: 'startup-error', type: 'startup', configuration: 200, application: 10, fail: true },
        { name: 'current-opening-legacy', type: 'workspace', catalog: 0, mount: 100, review: 100, storage: 20, roundtrip: 200 },
        { name: 'current-opening-fused', type: 'workspace', catalog: 0, mount: 100, review: 100, storage: 20, roundtrip: 200, opening: true },
        { name: 'navigation-cold', type: 'workspace', catalog: 120, mount: 180, review: 220, storage: 30 },
        { name: 'navigation-repeat', type: 'workspace', catalog: 30, mount: 80, review: 100, storage: 10, repeat: true },
        { name: 'navigation-slow-mount', type: 'workspace', catalog: 0, mount: 4500, review: 0, storage: 0 },
        { name: 'navigation-failure', type: 'workspace', catalog: 0, mount: 300, review: 0, storage: 0, fail: true },
        { name: 'navigation-cancel-hung', type: 'workspace', catalog: 0, mount: 10000, review: 0, storage: 0, cancel: true },
        { name: 'retained-request', type: 'workspace', catalog: 60, mount: 100, review: 150, storage: 40, patients: 200, create: 600, retained: true },
        { name: 'retained-request-slow', type: 'workspace', catalog: 0, mount: 0, review: 0, storage: 10, patients: 200, create: 4500, retained: true },
        { name: 'recording-cold', type: 'recorder', open: 150, start: 1800, input: 100 },
        { name: 'recording-repeat', type: 'recorder', open: 20, start: 40, input: 20, repeat: true },
        { name: 'recording-resume', type: 'recorder', open: 20, start: 40, input: 20, resume: true },
        { name: 'recording-slow-start', type: 'recorder', open: 0, start: 4500, input: 0 },
        { name: 'recording-no-input', type: 'recorder', open: 0, start: 20, input: 10000, noInput: true },
        { name: 'recording-failure', type: 'recorder', open: 0, start: 350, input: 0, fail: true },
        { name: 'recording-cancel-hung', type: 'recorder', open: 0, start: 10000, input: 0, cancel: true },
    ];
    const results = filter ? JSON.parse(await readFile(`${out}/BROWSER_TIMINGS.json`, 'utf8')).results.filter(r => !r.name.startsWith(filter)) : [];
    const selected = cases.filter(item => !filter || item.name.startsWith(filter));
    assert.ok(selected.length, 'No matching scenario');
    for (const cfg of selected) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(origin);
        await page.waitForFunction(() => window.lab);
        const run = page.evaluate(async (cfg) => {
            const L = window.lab, root = document.querySelector('#root'), t0 = performance.now();
            const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
            const wait = async (fn, max = 7000) => {
                const t = performance.now();
                while (!fn()) {
                    if (performance.now() - t > max)
                        throw Error(`Unfinished ${cfg.name}`);
                    await delay(5);
                }
            };
            const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const now = () => Math.round((performance.now() - t0) * 10) / 10;
            const unused = () => { throw Error('Unrequested service/audio operation'); };
            const marks = {}, RPC = [];
            const mark = name => marks[name] = now();
            const button = (label, scope = root) => [...(scope?.querySelectorAll('button') ?? [])].find(b => !b.hidden && (b.getAttribute('aria-label') === label || b.textContent.trim() === label));
            let completedAt, outcome;
            if (cfg.type === 'startup') {
                const dispose = L.mountProviderStartup(root, { configuration: async () => {
                        await delay(cfg.configuration);
                        if (cfg.fail)
                            throw Error('fixture unavailable');
                        return { enabled: true, coreOrigin: 'https://staging-app.cosmaneura.com', uploadOrigins: ['https://synthetic.blob.core.windows.net'] };
                    }, application: async () => { await delay(cfg.application); return { mount: root => { root.innerHTML = '<button data-fixture-ready>Your encounters</button>'; return async () => { }; } }; } });
                await wait(() => root.querySelector('[data-fixture-ready],[data-session-action="retry-startup"]'));
                await frame();
                completedAt = now();
                outcome = cfg.fail ? 'actionable-error' : 'actionable-ready';
                await dispose();
            }
            else if (cfg.type === 'workspace') {
                const abort = new AbortController(), revision = crypto.randomUUID(), recovery = '10000000-0000-4000-8000-000000000001', workspace = '20000000-0000-4000-8000-000000000002';
                const appointment = 'appointment_01j00000000000000000000000';
                const encounter = { appointmentRef: appointment, title: 'Synthetic performance visit', detail: 'Synthetic fixture' };
                const draft = { creationKey: crypto.randomUUID(), patient: { kind: 'existing', patientRef: 'patient_01j00000000000000000000000' }, appointmentAt: '2026-09-30T12:00:00Z', title: 'Synthetic performance' };
                const key = `provider-encounter-creation-v1:${recovery}`;
                if (cfg.retained)
                    window.labRecords.set(key, { key, revision: '1', data: btoa(JSON.stringify({ version: 1, recoveryScope: recovery, pending: draft })) });
                window.Capacitor.nativePromise = async (plugin, method, options) => {
                    if (plugin !== 'SecureQueue')
                        throw Error('native operation forbidden');
                    await delay(cfg.storage);
                    RPC.push({ action: `storage.${method}`, at: now() });
                    if (method === 'get') {
                        const row = window.labRecords.get(options.key);
                        if (row)
                            return structuredClone(row);
                        throw Object.assign(Error('fixture missing'), { code: 'SECURE_QUEUE_NOT_FOUND' });
                    }
                    if (method === 'list')
                        return { keys: [...window.labRecords.keys()] };
                    if (method === 'compareAndSwap') {
                        const row = window.labRecords.get(options.key);
                        if (!row || row.revision !== options.expectedRevision)
                            throw Error('fixture conflict');
                        const next = { ...options, revision: String(Number(row.revision) + 1) };
                        window.labRecords.set(options.key, next);
                        return { revision: next.revision };
                    }
                    throw Error('unexpected synthetic mutation');
                };
                const backend = await L.connectNativeProviderIOSBackend({ signal: abort.signal, uploadTarget: { putCompleteEnvelope: unused }, core: { createEncounter: unused, openEncounter: unused } }, { getProviderState: async () => ({ phase: 'ready', revision, providerReady: true }), addListener: async () => ({ remove: async () => { } }), cancelProviderRequest: async () => { RPC.push({ action: 'cancel', at: now() }); }, providerRequest: async (request) => {
                        const body = JSON.parse(request.body), action = request.action;
                        RPC.push({ action, stage: 'start', at: now() });
                        await delay((action === 'encounters' ? cfg[body.action] ?? 0 : action === 'capture-operations' ? cfg.review : cfg[action] ?? 0) + (cfg.roundtrip ?? 0) + (action === 'mount' && cfg.opening ? cfg.review : 0));
                        if (action === 'mount' && cfg.fail)
                            throw Error('fixture unavailable');
                        let value;
                        if (action === 'catalog')
                            value = { revision, encounters: [{ ...encounter, workspaceId: workspace }], encounter_creation_v1: true, opening_review_v1: cfg.opening === true, account: { email: 'synthetic@example.invalid' }, environment: 'Staging' };
                        else if (action === 'mount')
                            value = { revision, encounter, recoveryScope: recovery, workspaceId: workspace, appointmentRef: appointment, bindingRef: 'scribe_capture_binding_01j00000000000000000000000' };
                        else if (action === 'capture-operations')
                            value = { ...body, contract_version: '1', checked_at: new Date().toISOString(), operation: 'provider_encounter', receipt: { schema_version: '1.0', status: 'not_prepared', review: null } };
                        else if (action === 'encounters' && body.action === 'patients')
                            value = { revision, recoveryScope: recovery, account: { email: 'synthetic@example.invalid' }, more_results: false, patients: [{ patient_ref: draft.patient.patientRef, name: 'Synthetic patient', date_of_birth: null }] };
                        else if (action === 'encounters' && body.action === 'create') {
                            if (body.creation_key !== draft.creationKey || request.key !== draft.creationKey)
                                throw Error('retained key rotated');
                            value = { revision, recoveryScope: recovery, account: { email: 'synthetic@example.invalid' }, creation_key: draft.creationKey, encounter: { workspace_id: workspace, appointment_ref: appointment, patient_name: 'Synthetic patient', title: 'Synthetic performance', appointment_at: draft.appointmentAt } };
                        }
                        else
                            throw Error(`unexpected ${action}`);
                        if (action === 'mount' && cfg.opening)
                            value.openingReview = { contract_version: '1', workspace_id: workspace, binding_ref: value.bindingRef, request_nonce: body.opening_nonce, checked_at: new Date().toISOString(), operation: 'provider_encounter', receipt: { schema_version: '1.0', status: 'not_prepared', review: null } };
                        RPC.push({ action, stage: 'end', at: now() });
                        return { requestId: request.requestId, revision, status: 200, body: JSON.stringify(value) };
                    } });
                const dispose = L.mountProviderWorkspace(root, L.createProviderIOSHost(backend));
                await wait(() => root.querySelector('[data-workspace-action="open"]'));
                await frame();
                mark('catalogReady');
                if (cfg.retained) {
                    mark('newEncounterClick');
                    button('New visit').click();
                    await wait(() => button('Check and open visit'));
                    await frame();
                    mark('retainedReady');
                    button('Check and open visit').click();
                    mark('retryClick');
                }
                else {
                    root.querySelector('[data-workspace-action="open"]').click();
                    mark('openClick');
                }
                if (cfg.cancel) {
                    await wait(() => button('Cancel opening'));
                    mark('cancelAvailable');
                    await delay(250);
                    button('Cancel opening').click();
                    mark('cancelClick');
                    await wait(() => root.querySelector('[data-workspace-action="open"]'));
                    await frame();
                    mark('cancelSettled');
                    outcome = 'cancelled-ready';
                }
                else {
                    await wait(() => root.textContent.includes(cfg.fail ? 'Encounter could not open' : 'Record this visit'));
                    await frame();
                    mark('encounterReady');
                    outcome = cfg.fail ? 'actionable-error' : 'consent-ready';
                }
                if (cfg.repeat) {
                    root.querySelector('header [data-workspace-action="encounters"]').click();
                    await wait(() => root.querySelector('[data-workspace-action="open"]'));
                    root.querySelector('[data-workspace-action="open"]').click();
                    mark('repeatClick');
                    await wait(() => root.textContent.includes('Record this visit'));
                    await frame();
                    mark('repeatReady');
                }
                completedAt = now();
                abort.abort();
                await dispose();
                await backend.dispose();
                if (cfg.retained) {
                    const saved = JSON.parse(atob(window.labRecords.get(key).data));
                    if (saved.pending !== null)
                        throw Error('retained request not cleared after success');
                }
            }
            else {
                const native = L.recordingFixture(), abort = new AbortController();
                const storage = await L.EncryptedIndexedDbQueueStorage.open({ databaseName: `lab-${crypto.randomUUID()}` });
                const baseCommand = native.port.command;
                let generation = 0, starts = 0;
                native.port.open = async (_session, id) => { await delay(cfg.open); return native.response(id); };
                native.port.command = async (request) => {
                    RPC.push({ action: request.kind, at: now() });
                    if (request.kind === 'start') {
                        const thisRun = ++generation;
                        starts++;
                        await delay(cfg.start);
                        if (thisRun !== generation)
                            return native.response(request.requestId);
                        if (cfg.fail) {
                            native.set({ phase: 'paused', failure: 'startFailed' });
                            return { ...native.response(request.requestId), ok: false };
                        }
                        const result = await baseCommand(request);
                        mark(`phaseRecording${starts}`);
                        setTimeout(() => {
                            if (thisRun !== generation)
                                return;
                            native.set({ signal: { version: 2, signal: { inputBuffers: 12, convertedBuffers: 12, inputEverNonzero: true, convertedEverNonzero: true, inputLevel: 0.1, convertedLevel: 0.1, inputAgeMs: 0, convertedAgeMs: 0, zeroInputMs: 0, inputMuted: false, route: 'built_in' } } });
                            mark(`syntheticInput${starts}`);
                        }, cfg.input);
                        return result;
                    }
                    if (request.kind === 'pause' || request.kind === 'close') {
                        generation++;
                        native.set({ signal: { version: 2, signal: null } });
                    }
                    return baseCommand(request);
                };
                const prepared = await L.connectNativeProviderRecorder({ sessionId: L.syntheticSession, port: native.port, bff: new Proxy({}, { get: () => unused }), queueStorage: storage, uploadTarget: { putCompleteEnvelope: unused }, signal: abort.signal });
                const app = document.createElement('cosmaneura-capture');
                app.bindProvider({ sessionId: L.syntheticSession, controller: prepared.controller, sourceKind: 'microphone', captureMode: 'native_microphone', languageMode: 'english', signal: abort.signal, authorizedRequest: unused, journal: { load: unused, save: unused }, deactivate: prepared.deactivate });
                root.append(app);
                const shadow = () => app;
                await wait(() => button('Start recording', shadow()));
                await frame();
                mark('recorderReady');
                const active = () => shadow().querySelector('scribe-ios-input-meter')?.shadowRoot?.querySelector('h3')?.textContent === 'Recording';
                mark('startClick');
                button('Start recording', shadow()).click();
                await wait(() => button('Cancel start', shadow()));
                mark('cancelAvailable');
                if (cfg.cancel) {
                    await delay(250);
                    mark('cancelClick');
                    button('Cancel start', shadow()).click();
                    await wait(() => button('Start recording', shadow()) && !button('Start recording', shadow()).disabled);
                    await frame();
                    mark('cancelSettled');
                    outcome = 'cancelled-ready';
                }
                else if (cfg.noInput) {
                    await delay(4050);
                    mark('gateObserved');
                    if (active())
                        throw Error('false input completion');
                    outcome = 'input-unconfirmed';
                }
                else if (cfg.fail) {
                    await wait(() => prepared.controller.snapshot.statusCode === 'capture_start_failed' && button('Resume', shadow()) && !button('Resume', shadow()).disabled);
                    await frame();
                    mark('errorReady');
                    outcome = 'actionable-error';
                }
                else {
                    await wait(active);
                    await frame();
                    mark('inputUIReady');
                    outcome = 'synthetic-input-confirmed';
                    if (cfg.resume) {
                        button('Pause', shadow()).click();
                        await wait(() => button('Resume', shadow()) && !button('Resume', shadow()).disabled);
                        mark('resumeClick');
                        button('Resume', shadow()).click();
                        await wait(active);
                        await frame();
                        mark('resumeInputReady');
                    }
                }
                completedAt = now();
                app.remove();
                abort.abort();
                await prepared.deactivate();
                storage.close();
            }
            if (window.forbiddenMediaCalls !== 0)
                throw Error('media API invoked');
            return { name: cfg.name, fixture: cfg, marks, rpc: RPC, outcome, completedAt, forbiddenMediaCalls: window.forbiddenMediaCalls, viewport: { width: innerWidth, height: innerHeight } };
        }, cfg);
        let deadline;
        const result = await Promise.race([run, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Scenario deadline exceeded: ${cfg.name}`)), 15000); })]).finally(() => clearTimeout(deadline));
        assert.deepEqual(errors, [], `page errors ${cfg.name}`);
        const m = result.marks;
        const start = cfg.type === 'startup' ? 0 : cfg.type === 'workspace' ? (m.repeatClick ?? m.retryClick ?? m.openClick) : (m.resumeClick ?? m.startClick);
        const finish = cfg.type === 'startup' ? result.completedAt : cfg.type === 'workspace' ? (m.repeatReady ?? m.cancelSettled ?? m.encounterReady) : (m.resumeInputReady ?? m.cancelSettled ?? m.errorReady ?? m.inputUIReady ?? m.gateObserved);
        result.actionToCompletionMs = Math.round((finish - start) * 10) / 10;
        result.successWithin4s = ['actionable-ready', 'consent-ready', 'synthetic-input-confirmed'].includes(result.outcome) && result.actionToCompletionMs <= 4000;
        result.actionableWithin4s = result.outcome !== 'input-unconfirmed' && result.actionToCompletionMs <= 4000;
        results.push(result);
        console.log(`${cfg.name}: ${result.actionToCompletionMs}ms ${result.outcome} successful<=4s=${result.successWithin4s}`);
        await writeFile(`${out}/BROWSER_TIMINGS.json`, JSON.stringify({ source: JSON.parse(await readFile(`${out}/SOURCE.json`, 'utf8')), runtime: process.version, browser: browser.version(), realDevice: false, realMicrophone: false, clock: 'browser performance.now; two animation frames before completion', nativeServices: 'in-memory fixtures with explicit injected milliseconds', results }, null, 2) + '\n');
        await page.close();
    }
}
finally {
    await browser?.close();
    if (server.listening)
        await new Promise(resolve => server.close(resolve));
}
