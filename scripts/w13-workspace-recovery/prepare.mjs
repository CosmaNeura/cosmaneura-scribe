import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const INPUT_SHA256 = "900f26844b8b9d134c2a12a00ae9f7cd7a40282ee3a2578b79d85bbbb08408af";
const here = dirname(fileURLToPath(import.meta.url));
export const sha256 = value => createHash("sha256").update(value).digest("hex");

export async function repairBundle(bytes, { privateCatalog = false } = {}) {
  if (sha256(bytes) !== INPUT_SHA256) throw new Error("Unrecognized W13 input; no output prepared");
  const original = bytes.toString("utf8");
  const component = (await readFile(join(here, "native-workspace.js"), "utf8")).replace("export function", "function");
  const start = original.indexOf("function Q1(");
  const end = original.indexOf("function X1(", start);
  if (start < 0 || end < start) throw new Error("W13 component boundary missing");
  let result = original.slice(0, start) + component + `
const Q1 = createWorkspaceRecovery({React:O,jsx:f,WorkspaceAuth:DA,availableByDefault:qA,
  StatusScreen:Cn,EncounterWorkspace:om,parseState:G1,parseToken:$1,sameState:rp,privateCatalog:${privateCatalog}});
` + original.slice(end);
  function replaceOnce(before, after) {
    if (result.split(before).length !== 2) throw new Error("W13 request boundary changed");
    result = result.replace(before, after);
  }
  replaceOnce('super(r==="capture_notebook_changed"?',
    'super(r==="workspace_read_unavailable"?"Could not connect to the workspace service. Check your connection and choose an encounter to retry.":r==="capture_notebook_changed"?');
  // Only catalog reads use the signal. Mutation serialization/retry stays intact.
  replaceOnce("async function zt(n,i,r){", "async function zt(n,i,r,signal){");
  replaceOnce('headers:l,body:r===void 0?void 0:JSON.stringify(r)',
    'headers:l,...(signal?{signal}:{}),body:r===void 0?void 0:JSON.stringify(r)');
  replaceOnce('catalog:n=>zt("/workspaces",n)', `catalog:async n=>{
    if(${privateCatalog})return n.getCatalog();
    const controller=new AbortController();
    const timeout=window.setTimeout(()=>controller.abort(),30000);
    try{return await zt("/workspaces",n,undefined,controller.signal)}
    catch(error){if(error instanceof da)throw error;throw new da(503,"workspace_read_unavailable")}
    finally{window.clearTimeout(timeout)}
  }`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("Usage: prepare.mjs retained-entry.js new-output-directory");
  const bytes = await readFile(input);
  const result = await repairBundle(bytes);
  // A new directory is mandatory. Preserve every original package and candidate.
  await mkdir(output);
  await writeFile(join(output, "index-BOeSnvhj.js"), result, { flag: "wx" });
  await writeFile(join(output, "manifest.json"), JSON.stringify({
    purpose: "offline W13 encounter error recovery; not an installable or connected candidate",
    input_sha256: INPUT_SHA256, output_sha256: sha256(result),
    component_sha256: sha256(await readFile(join(here, "native-workspace.js"))),
    endpoint_changed: false, native_auth_changed: false, installed: false,
    phone_connection_fixed: false,
  }, null, 2) + "\n", { flag: "wx" });
  console.log("Prepared W13 web correction; native package and endpoint remain unchanged.");
}
