import type { DesktopRecordingWindow } from "./recording-window.js";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { exact } from "../../capture/src/provider/desktop-host-protocol";
import { HttpCiphertextUploadTarget } from "../../capture/src/bff/upload-target";
import type { DesktopProviderOwner } from "./electron-provider-host.js";
import { NativeProviderClient } from "./native-provider-client.js";
import { NativeProviderPresentation } from "./native-provider-presentation.js";
import { connectDesktopNativeBackend } from "./native-provider-backend.js";
import { createDesktopProviderConnection } from "./provider-workspace-factory.js";
import { openDeviceCustody, type DeviceProtection } from "./device-custody.js";
import { NO_DIAGNOSTICS, type RuntimeDiagnostic } from "./runtime-diagnostics.js";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import { desktopJournalRecords } from "./durable-provider-records.js";
import { NativeMicrophoneInputService } from "./native-microphone-inputs.js";
import { DesktopAudioPreflight } from "./desktop-audio-preflight.js";
import { microphonePreferenceScope, openMicrophonePreferences } from "./microphone-preferences.js";
import { resolveStandaloneNativeHelpers } from "./standalone-native-helpers.js";

interface PackagedRuntime {
  readonly packageDirectory: string;
  readonly userDataDirectory: string;
  readonly protection: DeviceProtection;
  readonly diagnostics?: RuntimeDiagnostic;
  readonly recordingWindow?: DesktopRecordingWindow;
  openExternal(url: string): Promise<void>;
}

/** The shipped main-process factory. Every executable and origin comes from the
 * reviewed package profile; argv, environment and renderer cannot select them. */
export async function openStandaloneProvider(runtime: PackagedRuntime): Promise<DesktopProviderOwner> {
  const diagnostics = runtime.diagnostics ?? NO_DIAGNOSTICS;
  if (process.platform !== "darwin" || typeof window !== "undefined"
    || "type" in process && process.type === "renderer") throw unavailable();
  const root = await realpath(runtime.packageDirectory);
  const profilePath = join(root, "provider-profile.json"), info = await lstat(profilePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw unavailable();
  const profile = exact(JSON.parse(await readFile(profilePath, "utf8")),
    ["schema", "enabled", "coreOrigin", "uploadOrigins", "auth", "audio", "presentation"]);
  if (profile.schema !== 1 || typeof profile.enabled !== "boolean"
    || profile.coreOrigin !== "https://staging-app.cosmaneura.com"
    || !Array.isArray(profile.uploadOrigins) || (profile.enabled ? profile.uploadOrigins.length !== 1 : profile.uploadOrigins.length > 1)
    || profile.uploadOrigins.some(value => typeof value !== "string" || !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(value))) throw unavailable();
  const [authOptions, audioOptions, presentationOptions] = await resolveStandaloneNativeHelpers(root, {
    auth: profile.auth, audio: profile.audio, presentation: profile.presentation,
  });
  const native = await NativeProviderClient.open({ ...authOptions, diagnostics }), abort = new AbortController();
  const connections = new Set<ReturnType<typeof createDesktopProviderConnection>>();
  const opening = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const dispose = (): Promise<void> => closing ??= (async () => {
    abort.abort(); await Promise.allSettled([...opening]);
    // Keep native identity/custody alive until every actual source confirms stop.
    for (const connection of connections) await connection.dispose();
    connections.clear(); await native.dispose();
  })().catch(error => { closing = undefined; throw error; });
  return { dispose, host: {
    session: native,
    connect: signal => {
      diagnostics("connect_begin");
      const run = (async () => {
        const linked = AbortSignal.any([signal, abort.signal, native.signal]);
        if (profile.enabled !== true || linked.aborted || !native.isReady()) throw unavailable();
        const uploadTarget = new HttpCiphertextUploadTarget(profile.uploadOrigins as string[], fetch, "azure_block_blob");
        const backend = await connectDesktopNativeBackend(native, { signal: linked, uploadTarget, diagnostics,
          creationRecords: async (recoveryScope, signal) => {
            const directory = join(runtime.userDataDirectory, "provider-creation-v1");
            // A separate encrypted namespace, scoped to Core's reviewed account.
            const workspaceId = "56f527ab-0caf-459b-bda9-cf7f0ca2f709";
            const custody = await openDeviceCustody(directory, runtime.protection, { recoveryScope, workspaceId }, signal);
            try {
              const store = await DurableDesktopRecordStore.open({ directory, recoveryScope, workspaceId, key: custody.key });
              if (signal.aborted || linked.aborted) { store.close(); throw unavailable(); }
              return { records: desktopJournalRecords(store.namespace("pending-creation")),
                close: async () => { store.close(); await custody.release(); } };
            } catch (error) { await custody.release(); throw error; }
          },
          openCore: async appointment => {
            if (linked.aborted) throw unavailable();
            const path = appointment === null ? "/notes" : "/notes/" + encodeURIComponent(appointment);
            await runtime.openExternal("https://staging-app.cosmaneura.com" + path);
          } });
        diagnostics("backend_ready");
        let presentation: NativeProviderPresentation | undefined;
        let preferences: Awaited<ReturnType<typeof openMicrophonePreferences>> | undefined;
        let preferencesOpening: Promise<NonNullable<typeof preferences>> | undefined;
        let preferenceScope: string | undefined;
        const currentPreferenceScope = (): string => {
          if (linked.aborted || backend.signal.aborted || !native.isReady() || !backend.account) throw unavailable();
          const scope=microphonePreferenceScope(backend.account);
          if (preferenceScope && preferenceScope !== scope) throw unavailable();
          return scope;
        };
        const preference = (): Promise<NonNullable<typeof preferences>> => {
          const scope=currentPreferenceScope();
          if (preferences) return Promise.resolve(preferences);
          preferenceScope=scope;
          return preferencesOpening ??= openMicrophonePreferences(join(runtime.userDataDirectory,"provider-audio-preferences-v1"),
            runtime.protection,backend.account!,AbortSignal.any([linked,backend.signal])).then(async value => {
              try { if (currentPreferenceScope() !== scope) throw unavailable();preferences=value;return value; }
              catch(error){await value.close();throw error;}
            }).catch(error=>{preferencesOpening=undefined;throw error;});
        };
        try {
          presentation = await NativeProviderPresentation.open({ enabled: true, ...presentationOptions,
            inlineMeetingSelection: true,
            diagnostics,
            isSessionActive: () => !linked.aborted && !backend.signal.aborted && native.isReady(),
            ...(runtime.recordingWindow ? { primaryWindowId: () => runtime.recordingWindow!.primaryWindowId() } : {}) });
          diagnostics("presentation_ready");
          const inputs = new NativeMicrophoneInputService({ ...audioOptions,
            diagnostics,
            loadSelectedUID: async () => { const store=await preference();currentPreferenceScope();return store.load(); },
            saveSelectedUID: async uid => { const store=await preference();currentPreferenceScope();await store.save(uid);currentPreferenceScope(); },
            isSessionActive: () => !linked.aborted && !backend.signal.aborted && native.isReady() });
          const audioPreflight = new DesktopAudioPreflight(inputs, presentation.listMeetingWindows);
          const connection = createDesktopProviderConnection(backend, { enabled: true,
            audioPreflight,
            directory: join(runtime.userDataDirectory, "provider-records-v1"),
            openCustody: (scope, operation) => openDeviceCustody(join(runtime.userDataDirectory, "provider-records-v1"), runtime.protection, scope, operation),
            indicator: presentation, presentation, selectWindow: presentation.selectWindow,
            prepareInBackground: true,
            listMeetingWindows: presentation.listMeetingWindows,
            showWindowChooser: presentation.showWindowChooser,
            ...(runtime.recordingWindow ? { recordingWindow: runtime.recordingWindow } : {}),
            native: { ...audioOptions, diagnostics, microphoneUID: () => inputs.selectedUID,
              isSessionActive: () => !linked.aborted && native.isReady() },
          }, linked);
          const owned = { workspace: connection.workspace,
            dispose: async () => { await connection.dispose(); await preferencesOpening?.catch(()=>undefined);await preferences?.close();connections.delete(owned); } };
          connections.add(owned); diagnostics("connect_ready"); return owned;
        } catch { await presentation?.dispose(); await backend.dispose(); await preferencesOpening?.catch(()=>undefined);await preferences?.close();throw unavailable(); }
      })();
      opening.add(run); void run.finally(() => opening.delete(run)).catch(() => diagnostics("connect_failed")); return run;
    },
  } };
}
function unavailable(): Error { return new Error("The standalone provider is unavailable."); }
