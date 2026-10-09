import { describe, expect, it, vi } from "vitest";
import { speakerNameSuggestion } from "../../../review-ui/src/creator-edit";
import { parseEncounterDisplay } from "./encounter-display";
import { parseCreatedEncounter, parseProviderAccount } from "./encounter-setup";
import { sessionState, type DesktopProviderPort } from "./desktop-host-protocol";
import { createDesktopProviderApplicationHost } from "./desktop-application";

const appointmentRef = "appointment_01j00000000000000000000000";

describe("known names remain optional display evidence", () => {
  it("keeps the explicit Core patient name without interpreting arbitrary titles", () => {
    const created = parseCreatedEncounter({ workspace_id: crypto.randomUUID(), appointment_ref: appointmentRef,
      patient_name: "Fictional Lucía Rivera", title: "Appointment, not a person", appointment_at: "2026-09-30T12:00:00Z" });
    expect(created.patientName).toBe("Fictional Lucía Rivera");
    expect(parseEncounterDisplay(created).patientName).toBe(created.patientName);
    expect(parseEncounterDisplay({ appointmentRef, title: "Fictional old title", detail: "Legacy" }).patientName).toBeUndefined();
    for (const patientName of [false, "", "\0", "x".repeat(201)]) {
      expect(() => parseEncounterDisplay({ ...created, patientName })).toThrow();
    }
  });

  it("does not truncate a valid long patient name into a different speaker name", () => {
    const encounter = parseEncounterDisplay({ appointmentRef, title: "Visit", detail: "Fixture", patientName: "x".repeat(121) });
    expect(encounter.patientName).toHaveLength(121);
    expect(speakerNameSuggestion(encounter.patientName)).toBeUndefined();
    expect(speakerNameSuggestion("Fictional Lucía 🩺")).toBe("Fictional Lucía 🩺");
    expect(speakerNameSuggestion("🩺".repeat(61))).toBeUndefined();
  });

  it("accepts legacy session state and withholds malformed profile metadata without loosening account keys", () => {
    const before = { phase: "ready", revision: crypto.randomUUID() };
    expect(sessionState(before)).toEqual(before);
    for (const providerDisplayName of [false, null, "", "bad\ud800name", "bad\u0001name", "x".repeat(121)]) {
      expect(sessionState({ ...before, providerDisplayName })).toEqual(before);
    }
    expect(sessionState({ ...before, providerDisplayName: "Fictional Avery" }).providerDisplayName).toBe("Fictional Avery");
    expect(sessionState({ ...before, phase: "signedOut", providerDisplayName: "Fictional Avery" }).providerDisplayName).toBeUndefined();
    expect(() => sessionState({ ...before, revision: "invalid", providerDisplayName: "Fictional Avery" })).toThrow();
    expect(() => parseProviderAccount({ email: "synthetic@example.invalid", environment: "Staging", displayName: "Unsupported" })).toThrow();
  });

  it.each(["signedOut", "ready"])("desktop exposes only its matching ready revision and clears on %s", async phase => {
    const revision = crypto.randomUUID(), connectionId = crypto.randomUUID();
    let publish: (event: unknown) => void = () => undefined;
    const request = vi.fn<DesktopProviderPort["request"]>(async value => ({ requestId: value.requestId, ok: true,
      result: value.method === "session_read" ? { phase: "ready", revision, providerDisplayName: "Fictional Avery" }
        : value.method === "connect" ? { connectionId, revision } : null }));
    const application = createDesktopProviderApplicationHost({ request, subscribe: listener => { publish = listener; return () => undefined; } }, {
      request: async () => { throw new Error("Recorder must not be called for display names"); }, subscribe: () => () => undefined,
    });
    try {
      await application.host.session.getState();
      const connection = await application.host.connect(new AbortController().signal);
      expect(connection.workspace.providerDisplayName).toBe("Fictional Avery");
      expect(request.mock.calls.map(([r]) => r.method)).toEqual(["session_read", "connect"]);
      publish({ kind: "session", state: { phase, revision: crypto.randomUUID(), providerDisplayName: "Another fictional person" } });
      expect(connection.workspace.providerDisplayName).toBeUndefined();
      expect(connection.workspace.signal.aborted).toBe(true);
    } finally { await application.dispose(); }
  });
});
