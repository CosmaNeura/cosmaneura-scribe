import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { exact, object } from "../../capture/src/provider/desktop-host-protocol";
import { HttpCiphertextUploadTarget } from "../../capture/src/bff/upload-target";
import type { DesktopProviderOwner } from "./electron-provider-host.js";
import { NativeProviderClient } from "./native-provider-client.js";
import { NativeProviderPresentation } from "./native-provider-presentation.js";
import { connectDesktopNativeBackend } from "./native-provider-backend.js";
import { createDesktopProviderConnection } from "./provider-workspace-factory.js";
import { openDeviceCustody, type DeviceProtection } from "./device-custody.js";
import { NO_DIAGNOSTICS, type RuntimeDiagnostic } from "./runtime-diagnostics.js";

interface PackagedRuntime {
  readonly packageDirectory: string;
  readonly userDataDirectory: string;
  readonly protection: DeviceProtection;
  readonly diagnostics?: RuntimeDiagnostic;
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
  const helper = async (input: unknown): Promise<{ helperPath: string; helperSha256: string }> => {
    const value = exact(object(input), ["path", "sha256"]);
    if (typeof value.path !== "string" || isAbsolute(value.path) || value.path.includes("\\")
      || value.path.split("/").some(part => !part || part === "." || part === "..")
      || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) throw unavailable();
    const path = join(root, value.path);
    if (await realpath(path) !== path || relative(root, path).startsWith("..")) throw unavailable();
    return { helperPath: path, helperSha256: value.sha256 };
  };
  const [authOptions, audioOptions, presentationOptions] = await Promise.all([
    helper(profile.auth), helper(profile.audio), helper(profile.presentation),
  ]);
  const native = await NativeProviderClient.open(authOptions), abort = new AbortController();
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
        const backend = await connectDesktopNativeBackend(native, { signal: linked, uploadTarget,
          openCore: async appointment => {
            if (linked.aborted) throw unavailable();
            const path = appointment === null ? "/notes" : "/notes/" + encodeURIComponent(appointment);
            await runtime.openExternal("https://staging-app.cosmaneura.com" + path);
          } });
        diagnostics("backend_ready");
        let presentation: NativeProviderPresentation | undefined;
        try {
          presentation = await NativeProviderPresentation.open({ enabled: true, ...presentationOptions,
            isSessionActive: () => !linked.aborted && !backend.signal.aborted && native.isReady() });
          diagnostics("presentation_ready");
          const connection = createDesktopProviderConnection(backend, { enabled: true,
            directory: join(runtime.userDataDirectory, "provider-records-v1"),
            openCustody: (scope, operation) => openDeviceCustody(join(runtime.userDataDirectory, "provider-records-v1"), runtime.protection, scope, operation),
            indicator: presentation, presentation, selectWindow: presentation.selectWindow,
            native: { ...audioOptions, diagnostics, isSessionActive: () => !linked.aborted && native.isReady() },
          }, linked);
          const owned = { workspace: connection.workspace,
            dispose: async () => { await connection.dispose(); connections.delete(owned); } };
          connections.add(owned); diagnostics("connect_ready"); return owned;
        } catch { await presentation?.dispose(); await backend.dispose(); throw unavailable(); }
      })();
      opening.add(run); void run.finally(() => opening.delete(run)).catch(() => diagnostics("connect_failed")); return run;
    },
  } };
}
function unavailable(): Error { return new Error("The standalone provider is unavailable."); }
