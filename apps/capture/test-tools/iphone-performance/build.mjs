import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { options, source as provenanceFor, sha256 } from './common.mjs';
const { repo, out } = await options();
await mkdir(dirname(out), { recursive: true });
try {
    await mkdir(out, { mode: 0o700 });
}
catch (error) {
    if (error.code === 'EEXIST')
        throw new Error('Output directory must not already exist; preserve this run and choose a fresh directory.', { cause:error });
    throw error;
}
const provenance = provenanceFor(repo);
const inputs = new Map();
const require = createRequire(`${repo}/package.json`);
const { build } = await import(require.resolve('vite'));
const source = `${repo}/apps/capture/src`;
await writeFile(`${out}/entry.ts`, [
    `export * from ${JSON.stringify(`${source}/provider-entry.ts`)};`,
    `export { connectNativeProviderRecorder } from ${JSON.stringify(`${source}/provider/native-recorder.ts`)};`,
    `export { recordingFixture, syntheticSession } from ${JSON.stringify(`${source}/provider/native-recorder.fixture.ts`)};`,
    `export { EncryptedIndexedDbQueueStorage } from ${JSON.stringify(`${source}/storage/encrypted-indexeddb.ts`)};`,
    `export { mountProviderStartup } from ${JSON.stringify(`${source}/provider/startup.ts`)};`,
    `export { createEncounterSetup } from ${JSON.stringify(`${source}/provider/encounter-setup.ts`)};`,
    `export { encounterSetupMarkup } from ${JSON.stringify(`${source}/provider/encounter-setup-view.ts`)};`,
].join('\n'));
await build({ root: `${repo}/apps/capture`, configFile: false, plugins: [{ name: 'performance-source-inventory', enforce: 'pre', async transform(_code, id) {
                if (id.startsWith(repo + '/') && !id.includes('?'))
                    inputs.set(id, await sha256(id));
            } }], build: { outDir: `${out}/web`, emptyOutDir: false, target: 'es2022', minify: false,
        lib: { entry: `${out}/entry.ts`, formats: ['es'], fileName: 'lab', cssFileName: 'lab' } } });
await writeFile(`${out}/web/index.html`, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="lab.css"><div id="root"></div><script>
window.labRecords = new Map(); window.nativeCalls = []; window.forbiddenMediaCalls = 0;
window.CapacitorCustomPlatform = {name:'ios'};
window.Capacitor = {PluginHeaders:[{name:'IOSPCM',methods:[]},{name:'CosmasWorkspaceAuth',methods:[]},{name:'SecureQueue',methods:['get','list','create','compareAndSwap'].map(name=>({name,rtype:'promise'}))}],
 nativePromise:async(plugin,method,options)=> { window.nativeCalls.push({plugin,method,key:options?.key});
 if(plugin!=='SecureQueue') throw new Error('Unexpected native API');
 if(method==='get') {const row=window.labRecords.get(options.key); if(row)return structuredClone(row);throw Object.assign(new Error('missing synthetic record'),{code:'SECURE_QUEUE_NOT_FOUND'});}
 if(method==='list')return {keys:[...window.labRecords.keys()]};
 throw new Error('Unexpected native mutation'); }};
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>{window.forbiddenMediaCalls++;throw new Error('microphone forbidden')},getDisplayMedia:()=>{window.forbiddenMediaCalls++;throw new Error('capture forbidden')}}});
</script><script type="module">import * as lab from './lab.js'; window.lab=lab;</script>`);
const inputHashes = {};
for (const [file, before] of [...inputs.entries()].sort()) {
    assert.equal(await sha256(file), before, 'Bundled source changed during build');
    inputHashes[file.slice(repo.length + 1)] = before;
}
const after = provenanceFor(repo);
for (const key of ['commit', 'trackedStatus', 'trackedDiffSha256'])
    assert.equal(after[key], provenance[key], 'Repository source changed during build');
const assets = {};
for (const name of ['lab.js', 'lab.css', 'index.html'])
    assets[name] = await sha256(`${out}/web/${name}`);
await writeFile(`${out}/SOURCE.json`, JSON.stringify({ ...provenance, inputs: inputHashes, bundleSha256: assets['lab.js'], assets, mode: 'actual emitted JS, fake native/Core replies; no microphone or device' }, null, 2) + '\n');
