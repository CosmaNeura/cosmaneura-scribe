import "../capture-app";
import type { CaptureApp } from "../capture-app";
import type { PreparedProviderRecorder } from "../provider-binding";
import { CaptureFlowController } from "../flow";
import { CaptureDeviceCustodyError } from "../capture/device-custody";
import { CaptureQueue } from "../queue/capture-queue";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import { HttpCreatorReviewApi, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { mountCreatorReview, renderNoteTranscript } from "../../../review-ui/src/creator-review-panel";
import { CoreCaptureBff, CoreCaptureClient, requireValue, reference,
  type LanguageMode } from "./core-client";
import { noteTemplates, parseDraft, pendingSave, resolveNote, reviewedSource, saveNote,
  type CoreDraft, type CoreNoteTemplate, type ReviewedSource } from "./core-notes";
import { assertProgress, type JournalSnapshot, type ProviderProgress } from "./workspace-journal";
import type { ProviderWorkspaceHost, AuthorizedProviderEncounter, ProviderRecorderResources } from "./workspace-contracts";
export type { ProviderWorkspaceHost, AuthorizedProviderEncounter, ProviderRecorderResources, ProviderEncounter } from "./workspace-contracts";
import "./workspace.css";

/** Product entry for the authorized native/BFF host; default preview never mounts it. */
export function mountProviderWorkspace(root: HTMLElement, host: ProviderWorkspaceHost): () => Promise<void> {
  let disposed = false, generation = 0, busy = false;
  let context: AuthorizedProviderEncounter | null = null;
  let client: CoreCaptureClient | null = null;
  let journal: JournalSnapshot = { revision: null, progress: null };
  let encounterAbort: AbortController | null = null;
  let closeRecorder: (() => Promise<void>) | null = null;
  let acquiringRecorder: Promise<ProviderRecorderResources | PreparedProviderRecorder> | null = null;
  let disposeContent: (() => void) | null = null;
  let templates: CoreNoteTemplate[] = [], source: ReviewedSource | null = null, draft: CoreDraft | null = null;
  let noteTranscript: CreatorReviewView | null = null;
  let currentSchema = "";
  let consentRenewalOffered = false;
  let openingRef: string | null = null;
  let pendingNavigation: "encounters" | "review" | null = null;
  let step = "request";
  root.classList.add("provider-workspace");
  root.innerHTML = `<header class="provider-header"><div><strong>Cosmaneura Scribe</strong><p data-provider-encounter></p></div><button data-workspace-action="encounters">Your encounters</button></header>
    <p data-workspace-notice role="status"></p><div data-workspace-navigation aria-live="polite"></div><div data-workspace-content></div>`;
  const content = root.querySelector<HTMLElement>("[data-workspace-content]")!;
  const notice = root.querySelector<HTMLElement>("[data-workspace-notice]")!;
  const navigation = root.querySelector<HTMLElement>("[data-workspace-navigation]")!;
  const encounterLabel = root.querySelector<HTMLElement>("[data-provider-encounter]")!;
  const current = (n: number): boolean => !disposed && !host.signal.aborted && n === generation;
  const authorized = (n: number): boolean => current(n) && context !== null && !client?.signal.aborted;
  const clearNavigation = (): void => { pendingNavigation = null; navigation.replaceChildren(); };
  const show = (markup: string): void => { clearNavigation(); disposeContent?.(); disposeContent = null; content.innerHTML = markup; };
  const persist = async (progress: ProviderProgress): Promise<void> => {
    requireValue(context && !client?.signal.aborted);
    const activeContext = context, activeClient = client;
    const saved = await activeContext.journal.save(journal, progress);
    requireValue(context === activeContext && client === activeClient && !activeClient?.signal.aborted);
    journal = saved;
  };
  const progress = (): ProviderProgress => { requireValue(journal.progress); return journal.progress; };
  const session = (): string => { const id = progress().sessionId; requireValue(id); return id; };

  const clearEncounter = async (): Promise<void> => {
    generation += 1;
    clearNavigation();
    encounterAbort?.abort(); encounterAbort = null;
    disposeContent?.(); disposeContent = null;
    content.replaceChildren(); draft = null; source = null; templates = []; noteTranscript = null;
    encounterLabel.textContent = "";
    consentRenewalOffered = false;
    openingRef = null;
    context = null; client = null; journal = { revision: null, progress: null };
    // A host acquisition can finish after revocation. Await its ownership handoff
    // so disposal cannot report success before those late handles are closed.
    if (acquiringRecorder) await acquiringRecorder.catch(() => undefined);
    const close = closeRecorder;
    if (close) {
      await close();
      if (closeRecorder === close) closeRecorder = null;
    }
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (disposed || busy || host.signal.aborted) return;
    busy = true; notice.textContent = ""; step = "request";
    root.setAttribute("aria-busy", "true");
    try { await action(); }
    catch (error) {
      if (!disposed && !host.signal.aborted) {
        notice.textContent = error instanceof RecorderStopUnconfirmed
          ? "Recording stop could not be confirmed. Stop it in the native app before continuing."
          : error instanceof CaptureDeviceCustodyError
            ? "This device could not confirm access to the recording key or saved recording state. Your saved work is retained."
            : step === "encounter list"
              ? "Your encounters could not be loaded. Check your connection, then retry."
              : `The ${step} could not be confirmed. Your saved work is retained. Return to Your encounters and reopen this encounter to recover.`;
        if (error instanceof CaptureDeviceCustodyError) {
          show('<h1>Recording access needed on this device</h1><p>If this recording was prepared on another device, continue on that device. Moving an unfinished recording between devices is not supported. If this is the original device, contact support before retrying. Do not remove Scribe or reset its data.</p><button data-workspace-action="encounters">Your encounters</button>');
        } else if (context && journal.progress?.pendingSave) {
          show('<h1>Confirm your previous save</h1><p>Your exact edits are retained for recovery.</p><button data-workspace-action="resolve">Recover note save</button>');
        } else if (openingRef) {
          show(`<h1>Encounter could not open</h1><p>Check your connection, then retry. Recording has not started.</p><button data-workspace-action="open" data-appointment="${escape(openingRef)}">Retry opening encounter</button>`);
        } else if (step === "encounter list") {
          show('<h1>Your encounters</h1><button data-workspace-action="encounters">Retry loading encounters</button>');
        }
      }
    } finally { busy = false; root.removeAttribute("aria-busy"); }
  };
  const list = async (): Promise<void> => {
    await clearEncounter();
    step = "encounter list";
    const n = generation;
    show("<h1>Your encounters</h1><p>Loading your authorized encounters…</p>");
    const encounters = await host.listEncounters(host.signal);
    if (!current(n)) return;
    requireValue(encounters.length <= 1000 && new Set(encounters.map(e => e.appointmentRef)).size === encounters.length);
    for (const e of encounters) requireValue(reference(e.appointmentRef, "appointment")
      && typeof e.title === "string" && e.title.length <= 300 && typeof e.detail === "string" && e.detail.length <= 1000);
    show(`<h1>Your encounters</h1><p>Choose an encounter to record, review, or continue its note.</p>
      <button data-workspace-action="create">Open Core dashboard</button><p>This opens Core in your browser, where a separate sign-in may be required. It does not create an encounter. After an encounter is assigned to you in Core, return here and select Your encounters to refresh.</p><ul class="provider-encounters">${encounters.map(e =>
      `<li><button data-workspace-action="open" data-appointment="${escape(e.appointmentRef)}"><strong>${escape(e.title)}</strong><span>${escape(e.detail)}</span></button></li>`).join("")}</ul>
      ${encounters.length ? "" : "<p>No encounters are available. Ask your practice to assign an encounter in Core.</p>"}`);
  };
  const preparation = (): void => {
    requireValue(context);
    show(`<h1>${escape(context.encounter.title)}</h1><p>${escape(context.encounter.detail)}</p>
      <h2>Prepare recording</h2><p>All parties must agree to recording and transcription. Recording starts only when you press Start recording and can be stopped at any time.</p>
      <label>Spoken language<select name="language"><option value="">Choose a language</option><option value="en-US">English</option><option value="en-US+es-US">English and Spanish</option></select></label>
      <label>Visit type<select name="modality"><option value="in_person">In person</option><option value="virtual">Video visit</option><option value="phone">Phone call</option></select></label>
      <label>Participant regions<input name="regions" placeholder="For example: US-NY" autocomplete="off"><small>Enter every participant’s country or region code, separated by commas.</small></label>
      <label class="provider-consent"><input name="consent" type="checkbox">All parties have agreed to recording and transcription.</label>
      <button data-workspace-action="prepare">Prepare secure recording</button>`);
  };
  const renewConsent = (): void => {
    const saved = progress();
    requireValue(saved.sessionId === null && !saved.uploaded && saved.pendingSave === null);
    consentRenewalOffered = true;
    const attestation = saved.admission.attestation;
    const visit = { in_person: "In person", virtual: "Video visit", phone: "Phone call" }[attestation.modality];
    show(`<h1>Confirm recording consent</h1><p>Your previous request did not prepare a recording. Confirm that everyone still agrees before continuing.</p>
      <p>${saved.admission.languageMode === "en-US" ? "English" : "English and Spanish"} · ${visit} · ${escape(attestation.participant_regions.join(", "))}</p>
      <label class="provider-consent"><input name="consent" type="checkbox">All parties still agree to recording and transcription.</label>
      <button data-workspace-action="renew-consent">Prepare secure recording</button>`);
  };
  const showReview = (openingView?: CreatorReviewView): void => {
    requireValue(client && context);
    show("");
    const api = new HttpCreatorReviewApi(session(), client.reviewRequest(session()));
    // recordOrReview just performed this authorized read for the same encounter.
    // Consume it once on mount; refresh/decisions/note handoff still read afresh.
    let first = openingView;
    const dispose = mountCreatorReview(content, {
      read: async () => { const view = first; first = undefined; return view ?? api.read(); },
      decide: (request, key) => api.decide(request, key),
    }, {
      journal: context.reviewJournal(session()), continueToNote: openNotes,
    });
    disposeContent = () => { first = undefined; dispose(); };
  };
  const recordOrReview = async (): Promise<void> => {
    requireValue(client && context);
    const n = generation, id = session(), activeClient = client, activeContext = context;
    step = "recording status check";
    const view = await new HttpCreatorReviewApi(id, activeClient.reviewRequest(id)).read();
    if (!authorized(n)) return;
    if (!["created", "capturing"].includes(view.status)) {
      if (!progress().uploaded) await persist({ ...progress(), uploaded: true });
      if (authorized(n)) showReview(view);
      return;
    }
    requireValue(!progress().uploaded);
    step = "device recording access";
    const acquisition = activeContext.recorder(id, activeClient.signal);
    acquiringRecorder = acquisition;
    let resources: ProviderRecorderResources | PreparedProviderRecorder;
    try { resources = await acquisition; }
    finally { if (acquiringRecorder === acquisition) acquiringRecorder = null; }
    const native = "controller" in resources ? resources : null;
    const local = "flowStore" in resources ? resources : null;
    const localController = local ? new CaptureFlowController({ bff: new CoreCaptureBff(activeClient, id),
      flowStore: local.flowStore, queue: new CaptureQueue(local.queueStorage), source: local.source,
      queueTransport: new BffCaptureQueueTransport(new CoreCaptureBff(activeClient, id), local.uploadTarget) }) : null;
    const controller = native?.controller ?? localController!;
    const lifecycle = native ?? localController!;
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => closing ??= (async () => {
      try {
        await lifecycle.deactivate();
        if (local) await local.release();
      }
      catch { closing = null; throw new RecorderStopUnconfirmed(); }
    })();
    closeRecorder = close;
    if (!authorized(n)) { await close(); return; }
    if (local && localController) {
      const active = await local.flowStore.getActiveCaptureState();
      const preparing = await local.flowStore.getPreparationState();
      requireValue((active === null || active.sessionId === id && active.reviewAfterUpload === true)
        && (preparing === null || preparing.sessionId === id && preparing.mode === "configured_core"));
      if (view.status === "capturing" && active === null && preparing === null) throw new CaptureDeviceCustodyError();
      step = "secure recording preparation";
      if (!await localController.restore()) await localController.prepareConfigured(id);
    }
    requireValue(controller.snapshot.sessionId === id);
    if (!authorized(n)) { await close(); return; }
    show("");
    const app = document.createElement("cosmaneura-capture") as CaptureApp;
    app.bindProvider({ sessionId: id, controller, sourceKind: native?.sourceKind ?? local!.source.kind,
      ...(native ? { captureMode: native.captureMode } : {}),
      languageMode: progress().admission.languageMode === "en-US" ? "english" : "english_spanish",
      authorizedRequest: activeClient.reviewRequest(id), journal: activeContext.reviewJournal(id),
      signal: activeClient.signal, deactivate: close, resumePendingUpload: () => lifecycle.resumePendingWork(),
      continueToNote: async () => {
        await persist({ ...progress(), uploaded: true });
        await lifecycle.releaseUploadedCapture();
        await openNotes();
      } });
    content.replaceChildren(app);
    disposeContent = () => app.remove();
  };
  const admit = async (mode: "initial" | "recover" | "renew" = "initial"): Promise<void> => {
    requireValue(client);
    const n = generation;
    step = "recording admission";
    show("<h2>Preparing your recording…</h2>");
    const intent = progress().admission;
    const id = await (mode === "recover" ? client.recoverAdmission(intent)
      : mode === "renew" ? client.renewAdmission(intent) : client.admit(intent));
    if (!authorized(n)) return;
    if (id === null) { renewConsent(); return; }
    requireValue(progress().sessionId === null || progress().sessionId === id);
    if (progress().sessionId === null) await persist({ ...progress(), sessionId: id });
    if (authorized(n)) await recordOrReview();
  };
  const open = async (ref: string): Promise<void> => {
    await clearEncounter(); const n = generation;
    openingRef = ref; step = "encounter connection";
    show("<h1>Opening encounter</h1><p>Checking access and restoring your saved work…</p>");
    const opening = new AbortController();
    encounterAbort = opening;
    forwardAbort(host.signal, opening);
    const opened = await host.openEncounter(ref, opening.signal);
    if (!current(n)) return;
    requireValue(opened.encounter.appointmentRef === ref && opened.scope.appointmentRef === ref && !opened.signal.aborted);
    context = opened;
    encounterLabel.textContent = opened.encounter.title;
    forwardAbort(opened.signal, opening);
    const signal = opening.signal;
    client = new CoreCaptureClient(opened.scope, opened.request, signal);
    signal.addEventListener("abort", () => {
      if (!current(n)) return;
      void clearEncounter().catch(() => { if (!disposed) notice.textContent = "Recording stop could not be confirmed. Stop it in the native app before continuing."; });
      notice.textContent = "Encounter access ended. Return to your encounters to continue.";
    }, { once: true });
    step = "saved encounter recovery";
    const loaded = await opened.journal.load();
    if (!authorized(n)) return;
    journal = loaded;
    if (loaded.progress) {
      assertProgress(loaded.progress);
      if (loaded.progress.pendingSave) {
        show(`<h1>Confirm your previous save</h1><p>A note save needs confirmation before you can edit again.</p><button data-workspace-action="resolve">Recover note save</button>`);
      } else if (loaded.progress.sessionId) await recordOrReview();
      else show(`<h1>Recover recording preparation</h1><p>Confirm the original request before starting another recording.</p><button data-workspace-action="admit">Retry preparation</button>`);
    } else preparation();
    if (current(n)) openingRef = null;
  };
  async function openNotes(): Promise<void> {
    requireValue(client && context);
    const n = generation;
    const currentClient = client;
    const view = await new HttpCreatorReviewApi(session(), currentClient.reviewRequest(session())).read();
    if (!authorized(n)) return;
    source = reviewedSource(view);
    if (!progress().uploaded) await persist({ ...progress(), uploaded: true });
    templates = await noteTemplates(currentClient, session());
    if (!authorized(n)) return;
    show(`<h1>Your Core note</h1><p>The English transcript is ready. Choose your note template.</p>
      <label>Template<select name="schema"><option value="">Choose a template</option>${templates.map(t => `<option value="${escape(t.schema_ref)}">${escape(t.note_type)}</option>`).join("")}</select></label>
      <button data-workspace-action="read">Open note</button>${templates.length ? "" : "<p>No templates are available. Add a template in Core.</p>"}
      <button data-workspace-action="core">Open encounter in Core</button>`);
  }
  const readNote = async (prepare: boolean): Promise<void> => {
    requireValue(client && source && currentSchema);
    const n = generation, activeClient = client;
    // Recheck readiness and lineage for each view, including after save resolution.
    const view = await new HttpCreatorReviewApi(session(), activeClient.reviewRequest(session())).read();
    if (!authorized(n)) return;
    const fresh = reviewedSource(view);
    const value = await activeClient.note(session(), prepare ? "prepare" : "read", currentSchema);
    const result = await parseDraft(value, session(), currentSchema, fresh);
    if (!authorized(n)) return;
    source = fresh; draft = result; noteTranscript = view;
    renderNote();
  };
  const renderNote = (): void => {
    requireValue(draft);
    show(`<h1>${escape(draft.note_type)}</h1><p class="provider-draft-status">${draft.status === "draft" ? "Unreviewed Core draft · Review and edit before clinical use." : "No note has been prepared for this reviewed transcript."}</p>
      ${draft.reviewed_source.capture_continuity ? '<p role="status">Recording continuity is unconfirmed. Review this note for missing speech; gap lengths are unknown.</p>' : ""}
      ${draft.status === "draft" && noteTranscript ? renderNoteTranscript(noteTranscript) : ""}
      ${draft.status === "draft" ? draft.field_order!.map((key, index) => `<label>${escape(key)}<textarea data-note-field name="note-${index}" rows="5">${escape(draft!.fields![key]!)}</textarea></label>`).join("")
        + '<button data-workspace-action="save">Save edits to Core</button>' : '<button data-workspace-action="generate">Prepare Core note</button>'}
      <button data-workspace-action="review">Review transcript</button><button data-workspace-action="core">Open encounter in Core</button>`);
  };
  const navigate = async (destination: "encounters" | "review"): Promise<void> => {
    if (destination === "encounters") await list(); else showReview();
  };
  const guardNavigation = async (destination: "encounters" | "review"): Promise<void> => {
    // Keep the actual editor mounted. A navigation request never saves or
    // journals note text, and forced access closure still clears it immediately.
    const dirty = [...content.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")]
      .some(field => field.value !== field.defaultValue);
    if (!dirty) { await navigate(destination); return; }
    pendingNavigation = destination;
    navigation.innerHTML = '<p>Your note has unsaved edits. Save them to Core before leaving, or discard them.</p><button data-workspace-action="keep-editing">Keep editing</button><button data-workspace-action="discard-edits">Discard edits and leave</button>';
  };
  const click = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-workspace-action]") : null;
    if (!button || !root.contains(button)) return;
    void run(async () => {
      switch (button.dataset.workspaceAction) {
        case "encounters": await guardNavigation("encounters"); break;
        case "keep-editing": clearNavigation(); content.querySelector<HTMLTextAreaElement>("textarea[data-note-field]")?.focus(); break;
        case "discard-edits": {
          const destination = pendingNavigation;
          clearNavigation();
          if (destination) await navigate(destination);
          break;
        }
        case "create": await host.createEncounter(host.signal); await list(); break;
        case "open": await open(button.dataset.appointment!); break;
        case "prepare": {
          const language = input("language"), modality = input("modality");
          const consent = content.querySelector<HTMLInputElement>('[name="consent"]')?.checked;
          if (!consent || !["en-US", "en-US+es-US"].includes(language)) {
            notice.textContent = "Choose the spoken language and confirm all-party consent before preparing."; return;
          }
          const regions = [...new Set(input("regions").split(",").map(v => v.trim().toUpperCase()).filter(Boolean))].sort();
          if (!regions.length || regions.length > 16 || regions.some(v => !/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/u.test(v))) {
            notice.textContent = "Enter every participant’s country or region code, for example US-NY."; return;
          }
          const next: ProviderProgress = { admission: { key: crypto.randomUUID(), languageMode: language as LanguageMode,
            attestation: { modality: modality as "in_person" | "virtual" | "phone", participant_regions: regions,
              method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } },
          sessionId: null, uploaded: false, pendingSave: null };
          assertProgress(next); await persist(next); await admit(); break;
        }
        case "admit": await admit("recover"); break;
        case "renew-consent": {
          requireValue(consentRenewalOffered && progress().sessionId === null);
          if (!content.querySelector<HTMLInputElement>('[name="consent"]')?.checked) {
            notice.textContent = "Confirm that all parties still agree before preparing."; return;
          }
          consentRenewalOffered = false;
          // Preserve the original journal/key. Core retains the fresh attestation;
          // a lost reply is recovered without resubmitting any attestation.
          await admit("renew"); break;
        }
        case "read": currentSchema = input("schema"); requireValue(templates.some(t => t.schema_ref === currentSchema)); await readNote(false); break;
        case "generate": await readNote(true); break;
        case "review": await guardNavigation("review"); break;
        case "core": requireValue(context); await context.openInCore(draft?.note_ref ?? null); break;
        case "save": {
          requireValue(client && draft && !progress().pendingSave);
          clearNavigation();
          const n = generation;
          const fields = Object.fromEntries(draft.field_order!.map((key, i) => [key, input(`note-${i}`)]));
          const pending = pendingSave(draft, fields);
          await persist({ ...progress(), pendingSave: pending });
          show('<h1>Saving your edits…</h1><p>The original note version is retained.</p>');
          const saved = await saveNote(client, session(), pending);
          if (!authorized(n)) return;
          await persist({ ...progress(), pendingSave: null });
          if (!authorized(n)) return;
          draft = saved; renderNote(); notice.textContent = "Edits saved to Core. Clinical review is still required.";
          break;
        }
        case "resolve": {
          requireValue(client && progress().pendingSave);
          const n = generation, pending = progress().pendingSave!;
          const result = await resolveNote(client, session(), pending);
          if (!authorized(n)) return;
          source = pending.source; currentSchema = pending.schema;
          await readNote(false);
          if (!authorized(n)) return;
          await persist({ ...progress(), pendingSave: null });
          if (!authorized(n)) return;
          const unchanged = draft?.note_ref === pending.edit.expected_note_ref
            && draft?.note_sha256 === pending.edit.expected_note_sha256
            && draft?.source_sha256 === pending.edit.expected_source_sha256;
          if (result === "closed" && unchanged) {
            pending.fieldOrder.forEach((key, i) => {
              const field = content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`);
              if (field) field.value = pending.edit.fields[key]!;
            });
          }
          notice.textContent = result === "saved" ? "Previous save confirmed. The current Core draft is shown."
            : unchanged ? "The previous save did not complete. Your edits are restored below; review and save again."
              : "The previous save is closed. The Core draft changed; review its current version before editing again.";
          break;
        }
      }
    });
  };
  function input(name: string): string {
    return content.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? "";
  }
  let disposing: Promise<void> | null = null;
  const abort = (): void => { void dispose().catch(() => { /* Visible warning; the host can retry disposal. */ }); };
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    if (!disposed) {
      disposed = true; root.removeEventListener("click", click); host.signal.removeEventListener("abort", abort);
      root.replaceChildren();
    }
    disposing = clearEncounter().then(() => { root.replaceChildren(); }).catch(error => {
      root.textContent = "Recording stop could not be confirmed. Stop it in the native app before continuing.";
      disposing = null;
      throw error;
    });
    return disposing;
  };
  root.addEventListener("click", click); host.signal.addEventListener("abort", abort, { once: true });
  if (host.signal.aborted) abort(); else void run(list);
  return dispose;
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

class RecorderStopUnconfirmed extends Error {}

/** Early iOS 17 WebViews lack AbortSignal.any. Keep one owned encounter lifetime. */
function forwardAbort(source: AbortSignal, target: AbortController): void {
  if (target.signal.aborted || source === target.signal) return;
  const abort = (): void => target.abort(source.reason);
  if (source.aborted) { abort(); return; }
  source.addEventListener("abort", abort, { once: true });
  target.signal.addEventListener("abort", () => source.removeEventListener("abort", abort), { once: true });
}
