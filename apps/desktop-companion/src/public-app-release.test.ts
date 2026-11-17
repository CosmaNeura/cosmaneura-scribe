import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_DIRECT_BETA_MAC_NAME,
  PUBLIC_STORE_MAC_NAME,
  publicMacDisplayName,
} from "./public-app-release.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("public Mac display names", () => {
  it("keeps direct-beta naming and pins Store to Cosmas Scribe without Mac", () => {
    expect(PUBLIC_DIRECT_BETA_MAC_NAME).toBe("Cosmaneura Scribe for Mac");
    expect(PUBLIC_STORE_MAC_NAME).toBe("Cosmas Scribe");
    expect(PUBLIC_STORE_MAC_NAME).not.toMatch(/mac/i);
    expect(publicMacDisplayName("Direct beta")).toBe(PUBLIC_DIRECT_BETA_MAC_NAME);
    expect(publicMacDisplayName("Apple distribution")).toBe(PUBLIC_STORE_MAC_NAME);
    const release = JSON.parse(readFileSync(join(root, "desktop-release.json"), "utf8")) as {
      displayName: string;
    };
    expect(release.displayName).toBe(PUBLIC_DIRECT_BETA_MAC_NAME);
    const html = readFileSync(join(root, "standalone/provider.html"), "utf8");
    expect(html).toContain(`<title>${PUBLIC_DIRECT_BETA_MAC_NAME}</title>`);
  });
});
