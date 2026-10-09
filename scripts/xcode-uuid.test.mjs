import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve("@capacitor/cli/package.json"));
const xcode = cliRequire("xcode");
const xcodeRequire = createRequire(cliRequire.resolve("xcode"));

test("Xcode resolves the patched CommonJS UUID and rejects truncated output", () => {
  const uuid = xcodeRequire("uuid");
  assert.equal(xcodeRequire("uuid/package.json").version, "11.1.1");
  assert.match(uuid.v4(), /^[0-9a-f-]{36}$/u);
  const buffer = new Uint8Array(8).fill(170);
  assert.throws(() => uuid.v5("synthetic", uuid.v5.DNS, buffer, 4), RangeError);
  assert.deepEqual(buffer, new Uint8Array(8).fill(170));
});

test("Xcode can generate references and round-trip the existing iOS project", async () => {
  const source = new URL("../apps/capture/ios/App/App.xcodeproj/project.pbxproj", import.meta.url);
  const original = await readFile(source, "utf8");
  const directory = await mkdtemp(join(tmpdir(), "scribe-xcode-uuid-"));
  try {
    const path = join(directory, "project.pbxproj");
    await writeFile(path, original);
    const project = xcode.project(path).parseSync();
    const existing = project.getFirstTarget().uuid;
    const ids = new Set(Array.from({ length: 100 }, () => project.generateUuid()));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, /^[A-F0-9]{24}$/u);
    const added = project.addPbxGroup([], "Synthetic QA", "Synthetic QA");
    assert.match(added.uuid, /^[A-F0-9]{24}$/u);
    await writeFile(path, project.writeSync());
    const reopened = xcode.project(path).parseSync();
    assert.equal(reopened.getFirstTarget().uuid, existing);
    assert.equal(reopened.pbxGroupByName("Synthetic QA").name, "Synthetic QA");
    assert.equal(await readFile(source, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
