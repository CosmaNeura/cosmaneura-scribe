import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppiumUI } from './appium-ui.mjs';
import { ENGINEERING_BUDGETS, runJourney, validateScenario } from './engine.mjs';
import { runAccountMatrix } from './matrix.mjs';
import { recoverRun } from './recovery.mjs';
import { RECOVERY_OPERATION_TIMEOUT_MS } from './session-attempt.mjs';
import { runZoomBot, validateZoomConfig } from './zoom-bot.mjs';

async function journey({ scenario, nativeConfigPath, output, resume, signal }) {
  if (!resume) return runJourney({ scenario, adapter: new AppiumUI(nativeConfigPath), output, signal });
  let state;
  const recovery = await recoverRun({ scenario, adapter: new AppiumUI(nativeConfigPath), output, signal, mode: 'resume', timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS,
    resumeWithLease: async lease => {
      state = await runJourney({ scenario, adapter: new AppiumUI(nativeConfigPath), output, signal, resume: true, preacquiredLease: lease });
      return state;
    } });
  if (recovery.status !== 'RESUMED') throw Error(recovery.failureCode ?? 'recovery_capture_preserved');
  return state;
}

const [command, scenarioPath, nativePath, output] = process.argv.slice(2);
const lifetime = new AbortController();
process.once('SIGINT', () => lifetime.abort());
process.once('SIGTERM', () => lifetime.abort());
try {
  if (['zoom-doctor', 'zoom-run', 'zoom-resume'].includes(command)) {
    if (!scenarioPath || !nativePath || output) throw Error('usage_zoom_command_config_output');
    const config = validateZoomConfig(JSON.parse(await readFile(resolve(scenarioPath), 'utf8')));
    if (config.executionKind !== 'live') throw Error('zoom_cli_requires_live_config');
    const state = await runZoomBot({ configPath: resolve(scenarioPath), output: resolve(nativePath),
      command: command.slice(5), signal: lifetime.signal, onCheckpoint: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ status: state.status, account: state.account, code: state.failureCode,
      fullAcceptance: state.fullAcceptance, botMedia: state.botMedia, guardRetained: state.guardRetained }));
    process.exitCode = ['PROFILE_OBSERVED', 'CONNECTED_OBSERVED', 'AUTHORIZATION_OBSERVED'].includes(state.status) && !state.guardRetained ? 0 : 2;
  } else if (['matrix', 'matrix-resume'].includes(command)) {
    if (!scenarioPath || !nativePath || output) throw Error('usage_matrix_manifest_output');
    const result = await runAccountMatrix({ manifestPath: resolve(scenarioPath), output: resolve(nativePath),
      resume: command === 'matrix-resume', signal: lifetime.signal,
      runAccount: journey });
    console.log(JSON.stringify({ status: result.status, accounts: result.accounts.map(a => ({ id: a.id, status: a.status })),
      crossAccountIsolationStatus: result.crossAccountIsolationStatus, fullAcceptance: false }));
    process.exitCode = result.status === 'UI_MATRIX_PASS' ? 0 : 2;
  } else {
  if (!['doctor', 'run', 'resume', 'cleanup'].includes(command) || !scenarioPath || !nativePath || !output) throw Error('usage_doctor_run_resume_cleanup_scenario_native_output');
  const scenario = validateScenario(JSON.parse(await readFile(resolve(scenarioPath), 'utf8')));
  if (scenario.executionKind !== 'live') throw Error('cli_requires_live_scenario');
  const adapter = new AppiumUI(resolve(nativePath));
  if (command === 'doctor') {
    const result = await adapter.doctor(scenario);
    console.log(JSON.stringify({ ...result, budgets: ENGINEERING_BUDGETS })); process.exitCode = result.ready ? 0 : 2;
  } else if (command === 'cleanup') {
    const result = await recoverRun({ scenario, adapter, output: resolve(output), signal: lifetime.signal, mode: 'cleanup', timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS });
    console.log(JSON.stringify({ status: result.status, code: result.failureCode,
      targetLeaseRetained: result.targetLeaseRetained, nativeAppTerminated: false }));
    process.exitCode = result.status === 'CLEANED' ? 0 : 2;
  } else {
    const state = await journey({ scenario, nativeConfigPath: resolve(nativePath), output: resolve(output), resume: command === 'resume', signal: lifetime.signal });
    console.log(JSON.stringify({ status: state.status, completed: state.completed, fullAcceptance: false }));
  }
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'FAIL', code: /^[a-z_]{1,120}$/.test(error.message) ? error.message : 'coordinator_failure' }));
  process.exitCode = 2;
}
