import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {openFixtureRegistry, hash} from './fixture.mjs';
import {createParticipant} from './participant-session.mjs';
import {inspectParticipantResources} from './resource-owner.mjs';

const [root, playwrightPath, receiptPath] = process.argv.slice(2);
if (!root || !playwrightPath || !receiptPath) throw Error('usage: self-test.mjs FIXTURE_ROOT PLAYWRIGHT_MODULE RECEIPT_PATH');
const registryPath = new URL('./rounds.registry.json',import.meta.url);
const registry = await openFixtureRegistry({root,registryPath,registrySha256:hash(await readFile(registryPath))});
const fixtures = await Promise.all(['round1-two-patients','round2-corrections','round3-pause-resume'].map(caseId=>registry.load({caseId})));
const now = () => performance.timeOrigin + performance.now();
let productState = 'recording';
const resourceOwner = {runId:randomUUID(),ownedRoot:resolve(receiptPath)+'.owners'};
let participant;
const participantConfig = {fixture:fixtures[0],playwrightPath,executionKind:'loopback',
  resourceOwner,
  observeProduct:async()=>({scope:'product-ui',targetId:'loopback-mocked-observer',sessionId:'self-test-session',observedAtEpochMs:now(),
    consent:{sessionId:'self-test-session',state:'granted'},capture:{sessionId:'self-test-session',state:productState,nativeState:productState,elapsedSeconds:1}})};
const server = createServer((_request,response)=>{
  response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
  response.end(`<!doctype html><title>Owned synthetic stream self-test</title>
    <button id="request">Request generated stream</button><button id="ended">End generated stream</button>
    <button onclick="window.open(location.href)">Open owned popup</button><output id="level" role="status" aria-label="Retained stream RMS">0</output>
    <script>let stream;request.onclick=async()=>{stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const ctx=new AudioContext(),analyser=ctx.createAnalyser();ctx.createMediaStreamSource(stream).connect(analyser);await ctx.resume();
    setInterval(()=>{const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);
    document.getElementById('level').textContent=String(Math.sqrt(values.reduce((a,b)=>a+b*b,0)/values.length));},20);};
    ended.onclick=()=>stream.getTracks().forEach(track=>track.stop());</script>`);
});
async function until(check) {
  const deadline=now()+12_000;
  while(now()<deadline) {const value=await participant.status();if(check(value.media)) return value;await new Promise(r=>setTimeout(r,25));}
  throw Error('bounded-observation-timeout');
}
let result;
const observations = { retainedStreamSamples: [] };
const retain = (name, value) => { observations[name] = value; return value; };
try {
  participant = await createParticipant(participantConfig);
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  await participant.navigate(`http://127.0.0.1:${server.address().port}`);
  await participant.click({role:'button',name:'Open owned popup'});
  let pages;
  for(let n=0;n<40;n++){pages=await participant.pages();if(pages.length===2)break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(pages.length,2);await participant.select({pageId:pages.find(p=>!p.selected).pageId});
  await participant.click({role:'button',name:'Request generated stream'});
  const initial=retain('initial',await participant.status());assert.equal(initial.media.playing,false);assert.equal(initial.media.rms,0);
  const runningResources = retain('runningResources',await inspectParticipantResources({...resourceOwner,signal:new AbortController().signal}));
  assert.equal(runningResources.unresolvedOwnedResources.length,1);
  assert.equal(runningResources.unresolvedOwnedResources[0].reason,'owned_process_present');
  assert.equal(initial.media.tracks.filter(t=>t.state==='live').length,1);
  const before=retain('before',await participant.clockSample());
  const scheduled=retain('scheduled',await participant.schedule({fixtureSha256:fixtures[0].sha256,startAtEpochMs:now()+500,restart:true}));
  await assert.rejects(participant.schedule({fixtureSha256:fixtures[0].sha256,startAtEpochMs:now()+500,restart:true}),/source-playing/);
  await assert.rejects(participant.select({pageId:pages[0].pageId}),/source-playing/);
  const signal=retain('signal',await until(media=>media.firstSignal!==null&&media.rms>0.005));
  const paused=retain('paused',await participant.pause());await until(media=>media.rms===0);
  const resume=retain('resume',await participant.resume({startAtEpochMs:now()+500}));
  assert.equal(resume.media.scheduledClock.sourceOffsetSeconds,paused.media.offsetSeconds);
  await until(media=>media.offsetSeconds>paused.media.offsetSeconds+0.1);await participant.pause();
  await assert.rejects(participant.load(fixtures[1]),/idle-required/);
  productState='saved';const loaded=retain('loaded',await participant.load(fixtures[1]));await until(media=>media.rms===0);
  assert.deepEqual(loaded.media.tracks,initial.media.tracks);assert.equal(loaded.media.streamId,initial.media.streamId);
  assert.equal(loaded.media.offsetSeconds,0);assert.equal(loaded.media.playing,false);
  productState='recording';await assert.rejects(participant.schedule({fixtureSha256:fixtures[0].sha256,startAtEpochMs:now()+500,restart:true}),/fixture-changed/);
  await participant.schedule({fixtureSha256:fixtures[1].sha256,startAtEpochMs:now()+500,restart:true});
  const secondSignal=retain('secondSignal',await until(media=>media.firstSignal!==null&&media.rms>0.005));
  let retainedStreamRms = 0;
  const analyserDeadline = now() + 3000;
  while (now() < analyserDeadline) {
    const raw = await participant.readText({role:'status',name:'Retained stream RMS'});
    retainedStreamRms = Number(raw);
    observations.retainedStreamSamples.push({observedAtEpochMs:now(),raw,rms:retainedStreamRms});
    if (Number.isFinite(retainedStreamRms) && retainedStreamRms > 0.005) break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(retainedStreamRms > 0.005); // The retained stream's independent analyser receives audio.
  await participant.pause();productState='saved';await participant.load(fixtures[2]);
  await participant.click({role:'button',name:'End generated stream'});productState='recording';
  await assert.rejects(participant.schedule({fixtureSha256:fixtures[2].sha256,startAtEpochMs:now()+500,restart:true}),/no-requested-audio-stream/);
  result={status:'PASS',scope:'loopback WebAudio with mocked product observer; no Zoom, native capture, live consent or dashboard proof',
    executionKind:'loopback',syntheticOnly:true,initial,before,scheduled,signal,paused,resume,loaded,secondSignal,retainedStreamRms,observations,
    assertions:['initial silence','popup injection','nonzero stream signal','duplicate start rejection','pause silence',
      'resume retained offset','playing document switch rejection','idle required for switch','same live stream across switch','fixture mismatch rejection','ended track rejection']};
} catch(error) {
  if (participant) {
    observations.failureStatus = await participant.status().catch(failure=>({unavailable:failure.message}));
    observations.failureSnapshot = await participant.snapshot().catch(failure=>String(failure.message));
  } else if (typeof error.closeParticipant === 'function') {
    try { observations.factoryCleanup = await error.closeParticipant(); }
    catch(failure) { observations.factoryCleanupFailure = failure.message; }
  }
  result={status:'FAIL',scope:'loopback WebAudio only',executionKind:'loopback',syntheticOnly:true,failureCode:error.message,observations};process.exitCode=1;
}
finally {
  try {
    if (participant) {
      observations.participantCleanup = await participant.close(); observations.participantClosed = true;
      observations.closedResources = await inspectParticipantResources({...resourceOwner,signal:new AbortController().signal});
      assert.equal(observations.closedResources.unresolvedOwnedResources.length,0);
    }
  }
  catch(error) { observations.participantClosed = false; observations.cleanupFailure = error.message; result.status = 'FAIL'; process.exitCode=1; }
  if (server.listening) await new Promise(r=>server.close(r));
}
await writeFile(resolve(receiptPath),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({status:result.status,scope:result.scope,receiptPath:resolve(receiptPath)}));
