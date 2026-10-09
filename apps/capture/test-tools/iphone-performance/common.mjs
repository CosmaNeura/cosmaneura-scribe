import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, basename, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
export const toolDirectory = dirname(fileURLToPath(import.meta.url));
export async function options() {
    const { values } = parseArgs({ options: {
            checkout: { type: "string", default: resolve(toolDirectory, "../../../..") },
            output: { type: "string" }, filter: { type: "string" }, native: { type: "boolean" },
        } });
    if (!values.output)
        throw new Error("Pass --output with a fresh artifact directory outside the checkout.");
    const repo = await realpath(values.checkout);
    let ancestor = resolve(values.output);
    const tail = [];
    while (true) {
        try {
            ancestor = await realpath(ancestor);
            break;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = dirname(ancestor);
            if (parent === ancestor)
                throw error;
            tail.unshift(basename(ancestor));
            ancestor = parent;
        }
    }
    const out = resolve(ancestor, ...tail);
    const path = relative(repo, out);
    if (path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path))) {
        throw new Error("Keep generated performance artifacts outside the checkout.");
    }
    return { repo, out, filter: values.filter, native: values.native === true };
}
export function source(repo) {
    return {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
        trackedStatus: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }),
        trackedDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: repo })).digest("hex"),
        builtAt: new Date().toISOString(),
    };
}
export async function sha256(path) {
    return createHash("sha256").update(await readFile(path)).digest("hex");
}
