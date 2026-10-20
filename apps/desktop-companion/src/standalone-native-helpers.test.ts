import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStandaloneNativeHelpers, STORE_BRIDGE_BUNDLE_PATH } from "./standalone-native-helpers.js";
import { verifyNativeHelper } from "./native-process-driver.js";
import { openStandaloneProvider } from "./standalone-provider.js";

const native = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./native-provider-client.js", () => ({ NativeProviderClient: { open: native.open } }));

const unavailable = "The standalone provider is unavailable.";
const bytes = Buffer.from("synthetic unsigned bridge fixture; never executed\n");
const hash = createHash("sha256").update(bytes).digest("hex");
const roles = ["auth", "audio", "presentation"] as const;
type Role = typeof roles[number];
interface HelperDeclaration { path: string; sha256: string }
type Declarations = Record<Role, HelperDeclaration>;
const processDescriptors = ["mas", "execPath"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)] as const);
const versionDescriptors = ["electron", "node"].map(key => [key, Object.getOwnPropertyDescriptor(process.versions, key)] as const);
let temporary: string, application: string, root: string, executable: string, bridge: string;

function setProcess(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true });
}
function setVersion(key: string, value: string): void {
  Object.defineProperty(process.versions, key, { value, configurable: true });
}
function storeDeclarations(): Declarations {
  return Object.fromEntries(roles.map(role => [role, { path: STORE_BRIDGE_BUNDLE_PATH, sha256: hash }])) as Declarations;
}
async function profile(declarations = storeDeclarations()): Promise<void> {
  await writeFile(join(root, "provider-profile.json"), JSON.stringify({ schema: 1, enabled: false,
    coreOrigin: "https://staging-app.cosmaneura.com", uploadOrigins: [], ...declarations }));
}
function runtime() {
  return { packageDirectory: root, userDataDirectory: join(temporary, "unused-user-data"),
    protection: { isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn((_value: string): Buffer => { void _value; throw new Error("custody must remain unopened"); }),
      decryptString: vi.fn((_value: Buffer): string => { void _value; throw new Error("custody must remain unopened"); }) },
    openExternal: vi.fn(async (_url: string) => { void _url; return undefined; }) };
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), "scribe-helper-layout-test-")));
  application = join(temporary, "Synthetic.app");
  root = join(application, "Contents", "Resources", "app");
  executable = join(application, "Contents", "MacOS", "Cosmaneura Scribe Store");
  bridge = join(application, STORE_BRIDGE_BUNDLE_PATH);
  await mkdir(root, { recursive: true });
  await mkdir(join(application, "Contents", "MacOS"));
  await writeFile(executable, "synthetic Electron identity fixture; never executed\n", { mode: 0o755 });
  await writeFile(bridge, bytes, { mode: 0o755 });
  setProcess("mas", true); setProcess("execPath", executable);
  setVersion("electron", "44.4.3"); setVersion("node", "24.0.0");
  native.open.mockReset();
});
afterEach(async () => {
  for (const [key, descriptor] of processDescriptors) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
    else Reflect.deleteProperty(process, key);
  }
  for (const [key, descriptor] of versionDescriptors) {
    if (descriptor) Object.defineProperty(process.versions, key, descriptor);
    else Reflect.deleteProperty(process.versions, key);
  }
  await rm(temporary, { recursive: true, force: true });
});

describe("fixed Store helper selection", () => {
  it("the actual factory selects MacOS bytes and retains the real byte gate without opening custody", async () => {
    await mkdir(join(root, "native"));
    await writeFile(join(root, "native", "ScribeStorePipeBridge"), "different old resource fixture\n");
    await profile();
    const session = { signal: new AbortController().signal, isReady: () => false, dispose: vi.fn(async () => undefined) };
    // Only acquisition is substituted: the unchanged production filesystem/hash
    // verifier runs, but no helper, XPC service, backend or auth is started.
    native.open.mockImplementation(async (options: { helperPath: string; helperSha256: string }) => {
      await verifyNativeHelper(options); return session;
    });
    const packaged = runtime(), owner = await openStandaloneProvider(packaged);
    expect(native.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ helperPath: bridge, helperSha256: hash }));
    const resolved = await resolveStandaloneNativeHelpers(root, storeDeclarations());
    expect(resolved.map(value => value.helperPath)).toEqual([bridge, bridge, bridge]);
    expect(resolved.map(value => value.helperSha256)).toEqual([hash, hash, hash]);
    await owner.dispose();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(packaged.protection.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(packaged.protection.encryptString).not.toHaveBeenCalled();
    expect(packaged.protection.decryptString).not.toHaveBeenCalled();
    expect(packaged.openExternal).not.toHaveBeenCalled();
  });

  it.each(roles)("rejects a different %s declaration path before native acquisition", async role => {
    const declarations = storeDeclarations(); declarations[role].path = "native/ScribeStorePipeBridge";
    await profile(declarations);
    await expect(openStandaloneProvider(runtime())).rejects.toThrow(unavailable);
    expect(native.open).not.toHaveBeenCalled();
  });

  it.each(roles)("rejects a different %s SHA before native acquisition", async role => {
    const declarations = storeDeclarations(); declarations[role].sha256 = "a".repeat(64);
    await profile(declarations);
    await expect(openStandaloneProvider(runtime())).rejects.toThrow(unavailable);
    expect(native.open).not.toHaveBeenCalled();
  });

  it("does not allow matching declarations to bypass the actual helper byte verifier", async () => {
    await writeFile(bridge, "changed synthetic bridge bytes\n"); await profile();
    native.open.mockImplementation(async (options: { helperPath: string; helperSha256: string }) => verifyNativeHelper(options));
    await expect(openStandaloneProvider(runtime())).rejects.toThrow();
    expect(native.open).toHaveBeenCalledTimes(1);
  });

  it.each([["electron", "44.4.2"], ["node", "25.0.0"]] as const)("rejects unsupported %s runtime before acquisition", async (key, value) => {
    setVersion(key, value); await profile();
    await expect(openStandaloneProvider(runtime())).rejects.toThrow("mac_app_store_xpc_distribution_unavailable");
    expect(native.open).not.toHaveBeenCalled();
  });

  it("rejects another running executable and a noncanonical app package shape", async () => {
    setProcess("execPath", join(application, "Contents", "MacOS", "Another Host"));
    await expect(resolveStandaloneNativeHelpers(root, storeDeclarations())).rejects.toThrow(unavailable);
    setProcess("execPath", executable);
    const misplaced = join(temporary, "app"); await mkdir(misplaced);
    await expect(resolveStandaloneNativeHelpers(misplaced, storeDeclarations())).rejects.toThrow(unavailable);
    expect(native.open).not.toHaveBeenCalled();
  });

  it.each(["symlink", "directory"] as const)("rejects a %s at the fixed bridge location before acquisition", async kind => {
    await unlink(bridge);
    if (kind === "symlink") {
      const elsewhere = join(temporary, "different-helper"); await writeFile(elsewhere, bytes);
      await symlink(elsewhere, bridge);
    } else await mkdir(bridge);
    await profile();
    await expect(openStandaloneProvider(runtime())).rejects.toThrow(unavailable);
    expect(native.open).not.toHaveBeenCalled();
  });

  it("retains executable and write-mode rejection in the real helper verifier", async () => {
    const options = { helperPath: bridge, helperSha256: hash };
    await chmod(bridge, 0o644); await expect(verifyNativeHelper(options)).rejects.toThrow();
    await chmod(bridge, 0o777); await expect(verifyNativeHelper(options)).rejects.toThrow();
  });
});

describe("retained direct helper containment", () => {
  it("keeps three distinct relative declarations and hashes in the direct factory", async () => {
    setProcess("mas", false);
    const declarations = storeDeclarations(); await mkdir(join(root, "native"));
    for (const role of roles) {
      const payload = Buffer.from("synthetic direct " + role);
      declarations[role] = { path: "native/" + role, sha256: createHash("sha256").update(payload).digest("hex") };
      await writeFile(join(root, declarations[role].path), payload, { mode: 0o755 });
    }
    await profile(declarations);
    const session = { dispose: vi.fn(async () => undefined) };
    native.open.mockResolvedValue(session);
    const owner = await openStandaloneProvider(runtime());
    expect(native.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      helperPath: join(root, declarations.auth.path), helperSha256: declarations.auth.sha256 }));
    const resolved = await resolveStandaloneNativeHelpers(root, declarations);
    expect(resolved.map(value => value.helperSha256)).toEqual(roles.map(role => declarations[role].sha256));
    await owner.dispose();
  });

  it.each(["/absolute/helper", "native\\helper", "native//helper", "./native/helper", "native/../helper",
    "../../MacOS/ScribeStorePipeBridge", "native/"])("rejects direct path %s before acquisition", async path => {
    setProcess("mas", false);
    const declarations = storeDeclarations();
    for (const role of roles) declarations[role].path = path;
    await expect(resolveStandaloneNativeHelpers(root, declarations)).rejects.toThrow(unavailable);
    expect(native.open).not.toHaveBeenCalled();
  });

  it("rejects a direct symlink escape with the existing error", async () => {
    setProcess("mas", false); await mkdir(join(root, "native"));
    await symlink(bridge, join(root, "native", "auth"));
    const declarations = storeDeclarations();
    for (const role of roles) declarations[role].path = "native/auth";
    await expect(resolveStandaloneNativeHelpers(root, declarations)).rejects.toThrow(unavailable);
    expect(native.open).not.toHaveBeenCalled();
  });
});
