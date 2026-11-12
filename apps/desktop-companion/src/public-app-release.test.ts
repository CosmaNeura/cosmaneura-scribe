import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIC_MAC_NAME } from "./public-app-release.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("public Mac display name", () => {
  it("pins Cosmas Scribe without Mac in the user-visible name", () => {
    expect(PUBLIC_MAC_NAME).toBe("Cosmas Scribe");
    expect(PUBLIC_MAC_NAME).not.toMatch(/mac/i);
    const release = JSON.parse(readFileSync(join(root, "desktop-release.json"), "utf8")) as {
      displayName: string;
    };
    expect(release.displayName).toBe(PUBLIC_MAC_NAME);
    expect(release.displayName).not.toMatch(/mac/i);
    const html = readFileSync(join(root, "standalone/provider.html"), "utf8");
    expect(html).toContain("<title>Cosmas Scribe</title>");
    expect(html).not.toMatch(/for Mac|Scribe for Mac/i);
  });
});
