import "../capture-app";
import { Capacitor } from "@capacitor/core";
import type { CaptureApp } from "../capture-app";
import { isMicrophoneInput, microphoneInputs, type MicrophoneInput } from "../native/microphone-input";
import type { PreparedProviderRecorder } from "../provider-binding";
import { CaptureFlowController } from "../flow";
import { CaptureDeviceCustodyError } from "../capture/device-custody";
import { CaptureQueue } from "../queue/capture-queue";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import { HttpCreatorReviewApi, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { mountCreatorReview, renderNoteTranscript, bindTranscriptTools } from "../../../review-ui/src/creator-review-panel";
import { CoreCaptureBff, CoreCaptureClient, requireValue, reference,
  type LanguageMode } from "./core-client";
import { noteTemplates, parseDraft, pendingSave, resolveNote, checkNoteSave, reviewedSource, sameSource, saveNote,
  type CoreDraft, type CoreNoteTemplate, type ReviewedSource } from "./core-notes";
import { assertProgress, type JournalSnapshot, type ProviderProgress } from "./workspace-journal";
import type { ProviderWorkspaceHost, AuthorizedProviderEncounter, ProviderRecorderResources, ProviderEncounter } from "./workspace-contracts";
export type { ProviderWorkspaceHost, AuthorizedProviderEncounter, ProviderRecorderResources, ProviderEncounter } from "./workspace-contracts";
import "./workspace.css";
import { openingReviewView } from "./opening-review";
import { encounterSetupMarkup } from "./encounter-setup-view";
import type { EncounterDraft, EncounterSetupState } from "./encounter-setup";
import { readNoteOpening, type NoteOpening } from "./note-opening";
import { beginWorkflowTiming, type WorkflowTimingOutcome } from "./workflow-timing";
import { encounterDetail, encounterTimestamp, orderedNoteFields, noteFieldLabel } from "./workspace-display";
import { noteEditorPosition, restoreNoteEditorPosition, setNoteEditorPending, type NoteEditorPosition } from "./note-editor-state";
import { settledRecorderVisitStatus } from "./recent-visit-state";
import { bindNoteSourceNavigation } from "./note-source-navigation";
import { AutomaticProgress } from "../../../review-ui/src/automatic-progress";
import { encounterStatusCopy, pendingEncounterUpdates } from "./encounter-progress";

/** Product entry for the authorized native/BFF host; default preview never mounts it. */
export function mountProviderWorkspace(root: HTMLElement, host: ProviderWorkspaceHost): () => Promise<void> {
  const isIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
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
  let checkPreparedNote: (() => Promise<void>) | null = null;
  let currentSchema = "";
  let consentRenewalOffered = false;
  let consentAction: HTMLButtonElement | null = null;
  let openingRef: string | null = null;
  let cancelOpening: (() => void) | null = null;
  type NavigationDestination = "encounters" | "review" | (() => void);
  let pendingNavigation: NavigationDestination | null = null;
  let editorPosition: NoteEditorPosition | null = null;
  let lastEditorField: HTMLTextAreaElement | null = null;
  let refreshNoteSources: (() => void) | null = null;
  let setupQuery = "";
  let pendingDateOfBirth: { date: string; key: string } | null = null;
  let stopSaveCheck: (() => void) | null = null;
  let step = "request";
  let setupState: EncounterSetupState | null = null;
  const recentStates = new Map<string, { sessionId: string; status: "paused" | "processing" | "recording_saved" | "draft_ready" }>();
  const listedDraftRefs = new Set<string>();
  const hiddenVisits = new Set<string>();
  let listQuery = "", listFilter = "all";
  let selectedCreationPatient: EncounterDraft["patient"] | null = null;
  let preferredDesktopAudio: "microphone" | "meeting" = "microphone";
  let preferredLanguage: LanguageMode = "en-US"; // This authorized workspace's lifetime only.
  let preferredModality: "in_person" | "virtual" | "phone" = "in_person";
  root.classList.add("provider-workspace");
  root.innerHTML = `<p class="provider-account" data-provider-account hidden></p><header class="provider-header" hidden><div><strong>Cosmaneura Scribe</strong><p data-provider-encounter></p><p class="provider-patient-detail" data-provider-patient-detail></p></div><button data-workspace-action="encounters">Your encounters</button></header>
    <p data-workspace-notice role="status"></p><p data-workspace-progress hidden></p><div data-workspace-navigation aria-live="polite"></div><div data-workspace-content></div>`;
  const content = root.querySelector<HTMLElement>("[data-workspace-content]")!;
  const notice = root.querySelector<HTMLElement>("[data-workspace-notice]")!;
  const activity = root.querySelector<HTMLElement>("[data-workspace-progress]")!;
  const navigation = root.querySelector<HTMLElement>("[data-workspace-navigation]")!;
  const encounterLabel = root.querySelector<HTMLElement>("[data-provider-encounter]")!;
  const header = root.querySelector<HTMLElement>(".provider-header")!;
  const accountLabel = root.querySelector<HTMLElement>("[data-provider-account]")!;
  const patientDetail = root.querySelector<HTMLElement>("[data-provider-patient-detail]")!;
  const headerObserver = new ResizeObserver(() => root.style.setProperty("--provider-header-height", `${header.getBoundingClientRect().height}px`));
  headerObserver.observe(header);
  const current = (n: number): boolean => !disposed && !host.signal.aborted && n === generation;
  const authorized = (n: number): boolean => current(n) && context !== null && !client?.signal.aborted;
  const clearNavigation = (): void => {
    pendingNavigation = null; navigation.querySelector<HTMLDialogElement>("dialog")?.close(); navigation.replaceChildren();
  };
  const show = (markup: string): void => { stopSaveCheck?.(); stopSaveCheck = null; clearNavigation(); consentAction = null; disposeContent?.(); disposeContent = null; content.innerHTML = markup; };
  const persist = async (progress: ProviderProgress): Promise<void> => {
    requireValue(context && !client?.signal.aborted);
    const activeContext = context, activeClient = client;
    const saved = await activeContext.journal.save(journal, progress);
    requireValue(context === activeContext && client === activeClient && !activeClient?.signal.aborted);
    journal = saved;
  };
  const progress = (): ProviderProgress => { requireValue(journal.progress); return journal.progress; };
  const session = (): string => { const id = progress().sessionId; requireValue(id); return id; };
  const observeReview = (view: CreatorReviewView, n: number): void => {
    if (!authorized(n) || view.session_id !== journal.progress?.sessionId) return;
    const ref = context!.encounter.appointmentRef;
    const status = ["uploaded", "processing"].includes(view.status) ? "processing"
      : view.source !== null && view.working !== null ? "recording_saved" : undefined;
    if (status) recentStates.set(ref, { sessionId: view.session_id, status });
    else recentStates.delete(ref);
  };

  const clearEncounter = async (): Promise<void> => {
    generation += 1;
    listedDraftRefs.clear();
    stopSaveCheck?.(); stopSaveCheck = null; pendingDateOfBirth = null;
    clearNavigation();
    encounterAbort?.abort(); encounterAbort = null;
    disposeContent?.(); disposeContent = null;
    content.replaceChildren(); editorPosition = null; lastEditorField = null; draft = null; source = null; templates = []; noteTranscript = null;
    encounterLabel.textContent = ""; patientDetail.replaceChildren();
    consentRenewalOffered = false;
    consentAction = null;
    openingRef = null;
    cancelOpening = null;
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
  const run = async (action: () => Promise<void>, timingAction?: string): Promise<void> => {
    if (disposed || busy || host.signal.aborted) return;
    busy = true; notice.textContent = ""; step = "request";
    root.setAttribute("aria-busy", "true");
    const finishTiming = beginWorkflowTiming(timingAction);
    const started = performance.now();
    const activityTimer = setInterval(() => {
      if (disposed || host.signal.aborted) return;
      activity.hidden = !!content.querySelector("cosmaneura-capture");
      activity.textContent = `Working · ${Math.floor((performance.now() - started) / 1000)}s. ${step === "encounter connection"
        ? "Checking access to this visit." : step === "saved encounter recovery" ? "Restoring saved work."
        : step === "recording status check" ? "Checking recording status."
        : step === "device recording access" ? "Connecting this device to the recording."
        : step === "note preparation" ? "Preparing your draft note."
        : step === "recording admission" ? "Confirming recording consent and storage." : "Waiting for confirmation."}`;
    }, 1000);
    let outcome: WorkflowTimingOutcome = "resolved";
    try { await action(); }
    catch (error) {
      outcome = "threw";
      if (context) recentStates.delete(context.encounter.appointmentRef);
      if (!disposed && !host.signal.aborted) {
        notice.textContent = error instanceof RecorderStopUnconfirmed
          ? "Recording stop could not be confirmed. Stop it in the native app before continuing."
          : error instanceof CaptureDeviceCustodyError
            ? "This device could not confirm access to the recording key or saved recording state. Your saved work is retained."
            : context && journal.progress?.pendingSave
              ? ""
            : step === "encounter setup" || step === "encounter creation"
              ? "Your encounter request could not be confirmed. Check your connection, then check its result. Pending work is retained securely on this device."
            : step === "encounter list"
              ? "Your encounters could not be loaded. Check your connection, then retry."
              : `The ${step} could not be confirmed. Your saved work is retained. Return to Your encounters and reopen this encounter to recover.`;
        if (error instanceof CaptureDeviceCustodyError) {
          show('<h1>Recording access needed on this device</h1><p>If this recording was prepared on another device, continue on that device. Moving an unfinished recording between devices is not supported. If this is the original device, contact support before retrying. Do not remove Scribe or reset its data.</p><button data-workspace-action="encounters">Your encounters</button>');
        } else if (context && journal.progress?.pendingSave) {
          showSaveRecovery();
        } else if (step === "encounter setup" || step === "encounter creation") {
          show('<h1>Check encounter creation</h1><button data-workspace-action="check-creation">Check and continue</button><button data-workspace-action="encounters">Your encounters</button>');
        } else if (openingRef) {
          show(`<h1>Encounter could not open</h1><p>Check your connection, then retry. Recording has not started.</p><button data-workspace-action="open" data-appointment="${escape(openingRef)}">Retry opening encounter</button>`);
        } else if (step === "encounter list") {
          show('<h1>Your encounters</h1><button data-workspace-action="encounters">Retry loading encounters</button>');
        }
      }
    } finally {
      clearInterval(activityTimer); activity.hidden = true; activity.textContent = "";
      busy = false; root.removeAttribute("aria-busy");
      finishTiming(disposed || host.signal.aborted ? "cancelled" : outcome);
    }
  };
  const list = async (): Promise<void> => {
    await clearEncounter();
    header.hidden = true;
    step = "encounter list";
    const n = generation;
    show("<h1>Your encounters</h1><p>Loading your authorized encounters…</p>");
    const encounters = await host.listEncounters(host.signal);
    if (!current(n)) return;
    if (host.encounterSetup?.hidden) {
      const savedHidden = await host.encounterSetup.hidden(host.signal);
      if (!current(n)) return;
      hiddenVisits.clear(); for (const ref of savedHidden) hiddenVisits.add(ref);
    }
    const account = host.account;
    accountLabel.hidden = !account;
    accountLabel.textContent = account ? `${account.environment} · Signed in as ${account.email}` : "";
    const validate = (values: readonly ProviderEncounter[]): void => {
      requireValue(values.length <= 1000 && new Set(values.map(e => e.appointmentRef)).size === values.length);
      for (const e of values) requireValue(reference(e.appointmentRef, "appointment")
        && typeof e.title === "string" && e.title.length <= 300 && typeof e.detail === "string" && e.detail.length <= 1000
        && (e.status === undefined || ["draft_ready", "processing", "paused", "ready", "recording_saved"].includes(e.status)));
    };
    validate(encounters);
    const entries = new Map(encounters.map(entry => [entry.appointmentRef, entry]));
    const ordered = [...encounters].sort((a, b) => (encounterTimestamp(b.detail) ?? -Infinity) - (encounterTimestamp(a.detail) ?? -Infinity));
    for (const encounter of encounters) if (encounter.status === "draft_ready") listedDraftRefs.add(encounter.appointmentRef);
    const authorizedRefs = new Set(encounters.map(e => e.appointmentRef));
    for (const ref of recentStates.keys()) if (!authorizedRefs.has(ref)) recentStates.delete(ref);
    const pending = new Set<string>();
    show(`<div class="provider-list-heading"><h1>Your encounters</h1><button data-workspace-action="encounters" aria-label="Refresh encounters">Refresh</button></div>
      ${host.encounterSetup ? '<button data-workspace-action="new-encounter">New visit</button>' : ''}
      <div class="provider-list-filters"><label>Find a visit<input data-visit-search type="search" placeholder="Patient or visit" value="${escape(listQuery)}" autocomplete="off"></label>
      <div class="provider-visit-filters" role="group" aria-label="Show visits">${([
        ["all", "All visits"], ["today", "Today"], ["draft_ready", "Drafts ready"], ["paused", "Paused"], ["processing", "Processing"], ["hidden", "Hidden visits"],
      ] as const).map(([filter, label]) => `<button type="button" data-visit-filter="${filter}" aria-pressed="${listFilter === filter}">${label}</button>`).join("")}</div></div><p data-visit-count role="status"></p>
      <ul class="provider-encounters" aria-label="Authorized encounters">${ordered.map(e => {
        const status = e.status === "draft_ready" ? e.status : recentStates.get(e.appointmentRef)?.status ?? e.status;
        if (status === "processing") pending.add(e.appointmentRef);
        return `<li data-visit-ref="${escape(e.appointmentRef)}" data-visit-time="${encounterTimestamp(e.detail) ?? ""}"><button data-workspace-action="open" data-appointment="${escape(e.appointmentRef)}"><strong>${escape(e.title)}</strong><span>${escape(encounterDetail(e.detail))}</span>${status ? `<span class="provider-visit-status">${encounterStatusCopy(status)}</span>` : ""}</button><span data-draft-action>${e.status === "draft_ready" ? openDraftButton(e) : ""}</span>${status === undefined || status === "ready" ? `<button class="provider-hide-visit" data-workspace-action="hide-visit" data-appointment="${escape(e.appointmentRef)}">${hiddenVisits.has(e.appointmentRef) ? "Restore" : "Hide"}</button>` : ""}</li>`;
      }).join("")}</ul>
      ${encounters.length ? "" : "<p>No encounters are available yet.</p>"}
      <p data-encounter-progress role="status">${pending.size ? "Checking your processing visits automatically." : ""}</p>
      <details class="provider-encounter-help"${encounters.length ? "" : " open"}><summary>Missing an encounter?</summary><p>Ask your practice to assign the encounter in Core. The dashboard opens in your browser and may require a separate sign-in. It does not create an encounter. After assignment, return to Scribe and select Refresh.</p><button data-workspace-action="create">Open Core dashboard</button></details>`);
    const controller = new AbortController(); forwardAbort(host.signal, controller);
    const listElement = content.querySelector(".provider-encounters")!;
    const progressLabel = content.querySelector<HTMLElement>("[data-encounter-progress]")!;
    const searchInput = content.querySelector<HTMLInputElement>("[data-visit-search]");
    const filterGroup = content.querySelector<HTMLElement>(".provider-visit-filters");
    const filterVisits = (): void => {
      listQuery = searchInput?.value ?? listQuery;
      for (const button of filterGroup?.querySelectorAll<HTMLButtonElement>("[data-visit-filter]") ?? []) {
        button.setAttribute("aria-pressed", String(button.dataset.visitFilter === listFilter));
      }
      const query = listQuery.trim().toLocaleLowerCase(), today = new Date(); let visible = 0;
      for (const row of listElement.querySelectorAll<HTMLElement>("[data-visit-ref]")) {
        const ref = row.dataset.visitRef!, entry = entries.get(ref);
        if (!entry) continue;
        const status = entry.status === "draft_ready" ? entry.status : recentStates.get(ref)?.status ?? entry.status;
        const stamp = encounterTimestamp(entry.detail), date = stamp === null ? null : new Date(stamp);
        const isToday = date !== null && date.toDateString() === today.toDateString();
        row.hidden = !(listFilter === "hidden" ? hiddenVisits.has(ref) : !hiddenVisits.has(ref))
          || !!query && !`${entry.title} ${entry.detail}`.toLocaleLowerCase().includes(query)
          || listFilter === "today" && !isToday
          || !["all", "today", "hidden"].includes(listFilter) && status !== listFilter;
        if (!row.hidden) visible += 1;
      }
      const count = content.querySelector<HTMLElement>("[data-visit-count]");
      if (count) count.textContent = visible ? `${visible} visit${visible === 1 ? "" : "s"}` : "No visits match. Change your search or filter.";
    };
    const selectFilter = (event: MouseEvent): void => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-visit-filter]") : null;
      if (!button || !filterGroup?.contains(button) || !["all", "today", "draft_ready", "paused", "processing", "hidden"].includes(button.dataset.visitFilter ?? "")) return;
      listFilter = button.dataset.visitFilter!; filterVisits();
    };
    searchInput?.addEventListener("input", filterVisits); filterGroup?.addEventListener("click", selectFilter); filterVisits();
    const observer = new AutomaticProgress({
      active: () => current(n) && !controller.signal.aborted && listElement.isConnected,
      pending: () => pending.size > 0,
      visible: () => document.visibilityState === "visible",
      read: async signal => {
        const reading = new AbortController(); forwardAbort(controller.signal, reading); forwardAbort(signal, reading);
        try { return await interruptibleRead(host.listEncounters(reading.signal), reading.signal); } finally { reading.abort(); }
      },
      apply: fresh => {
        validate(fresh);
        const { updates, removed } = pendingEncounterUpdates(pending, fresh);
        const buttons = [...listElement.querySelectorAll<HTMLButtonElement>('[data-workspace-action="open"]')];
        for (const ref of removed) {
          pending.delete(ref); recentStates.delete(ref); listedDraftRefs.delete(ref);
          buttons.find(button => button.dataset.appointment === ref)?.closest("li")?.remove();
        }
        for (const e of updates) {
          entries.set(e.appointmentRef, e);
          const button = buttons.find(item => item.dataset.appointment === e.appointmentRef);
          if (!button) { pending.delete(e.appointmentRef); continue; }
          // Core catalog currently reports saved transcript/draft evidence only.
          // Absent status is not proof that the observed processing has ended.
          if (e.status === undefined) continue;
          if (e.status === "draft_ready") listedDraftRefs.add(e.appointmentRef); else listedDraftRefs.delete(e.appointmentRef);
          const draftAction = button.closest("li")?.querySelector<HTMLElement>("[data-draft-action]");
          if (draftAction) draftAction.innerHTML = e.status === "draft_ready" ? openDraftButton(e) : "";
          const status = button.querySelector<HTMLElement>(".provider-visit-status");
          if (status) status.textContent = encounterStatusCopy(e.status);
          if (e.status !== "processing") { pending.delete(e.appointmentRef); recentStates.delete(e.appointmentRef); }
        }
        filterVisits();
        progressLabel.textContent = pending.size ? "Checking your processing visits automatically." : "Visit status updated.";
      },
      stopped: reason => { progressLabel.textContent = reason === "deadline"
        ? "Automatic checking paused. Select Refresh to check your visits again."
        : "Visit status could not be confirmed. Check your connection, then select Refresh."; },
    });
    const visibility = (): void => {
      observer.pause(); if (document.visibilityState === "visible") observer.schedule(true);
    };
    controller.signal.addEventListener("abort", () => observer.dispose(), { once: true });
    document.addEventListener("visibilitychange", visibility);
    disposeContent = () => { observer.dispose(); controller.abort(); document.removeEventListener("visibilitychange", visibility); searchInput?.removeEventListener("input", filterVisits); filterGroup?.removeEventListener("click", selectFilter); };
    observer.schedule();
  };
  const setup = async (checkPending = false): Promise<void> => {
    requireValue(host.encounterSetup);
    await clearEncounter(); header.hidden = true; step = "encounter setup";
    const n = generation;
    show('<h1>New visit</h1><p>Loading your patients…</p>');
    const state = await host.encounterSetup.state(host.signal);
    if (!current(n)) return;
    requireValue(!host.account || host.account.email === state.account);
    setupState = state;
    // Only an explicit recovery action can resubmit the retained request.
    // Ordinary New encounter navigation still stops at the pending-request screen.
    if (checkPending && state.pending) await create(null);
    else showSetup();
  };
  const create = async (patient: EncounterDraft["patient"] | null): Promise<void> => {
    requireValue(host.encounterSetup && setupState);
    step = "encounter creation";
    const n = generation;
    const draft: EncounterDraft | null = patient === null ? null : {
      creationKey: crypto.randomUUID(), patient, appointmentAt: new Date().toISOString(), title: "Visit",
    };
    show('<h1>Creating your encounter…</h1><p>Saving to Core. Recording has not started.</p>');
    const created = await host.encounterSetup.submit(draft, host.signal);
    if (!current(n)) return;
    setupState = null;
    await open(created.appointmentRef);
  };
  const showSetup = (query = "", creating = false): void => {
    requireValue(setupState); setupQuery = query;
    show(encounterSetupMarkup(setupState, query, creating));
    const search = content.querySelector<HTMLFormElement>("[data-patient-search]");
    const newPatient = content.querySelector<HTMLFormElement>("[data-new-patient]");
    const onSearch = (event: SubmitEvent): void => {
      event.preventDefault();
      void run(async () => {
        requireValue(host.encounterSetup && setupState);
        step = "encounter setup";
        const n = generation, query = input("patient-query").trim();
        if (!query) return;
        const result = await host.encounterSetup.search(query, host.signal);
        if (!current(n)) return;
        requireValue(result.account === setupState.account);
        setupState = { ...result, pending: setupState.pending }; showSetup(query);
        content.querySelector<HTMLElement>(".provider-results-heading, .provider-create-choice")?.focus({ preventScroll: true });
      }, "patient-search");
    };
    const onNew = (event: SubmitEvent): void => {
      event.preventDefault();
      if (!newPatient?.reportValidity() || input("patient-query").trim() !== setupQuery) return;
      const name = input("new-patient-name").trim(), dateOfBirth = input("new-patient-dob") || null;
      if (!name) { notice.textContent = "Enter the patient's name."; return; }
      selectedCreationPatient = { kind: "new", name, dateOfBirth }; confirmCreation(name);
    };
    const searchInput = search?.querySelector<HTMLInputElement>("input");
    const updateResults = (): void => {
      const changed = searchInput?.value.trim() !== setupQuery;
      for (const button of content.querySelectorAll<HTMLButtonElement>('[data-workspace-action="select-patient"], [data-workspace-action="new-patient"], [data-new-patient] button[type="submit"]')) button.disabled = changed;
    };
    search?.addEventListener("submit", onSearch); searchInput?.addEventListener("input", updateResults); newPatient?.addEventListener("submit", onNew);
    disposeContent = () => { search?.removeEventListener("submit", onSearch); searchInput?.removeEventListener("input", updateResults); newPatient?.removeEventListener("submit", onNew); };
  };
  const confirmCreation = (name: string): void => {
    show(`<section class="provider-setup"><h1>Start a visit for ${escape(name)}</h1><p>This will create a visit in the patient chart. Recording starts after you confirm consent on the next screen.</p><button data-workspace-action="confirm-create">Create visit &amp; continue</button><button data-workspace-action="patient-results">Back</button><button data-workspace-action="encounters">Cancel</button></section>`);
  };
  const renderPatientDetails = (encounter: AuthorizedProviderEncounter["encounter"]): void => {
    patientDetail.replaceChildren();
    if (encounter.dateOfBirth === undefined) return;
    const label = document.createElement("span");
    label.textContent = encounter.dateOfBirth ? `DOB: ${encounter.dateOfBirth}` : "DOB not provided";
    patientDetail.append(label);
    if (encounter.dateOfBirth === null && encounter.patientRef && host.encounterSetup?.addDateOfBirth) {
      const button = document.createElement("button"); button.dataset.workspaceAction = "add-dob"; button.textContent = "Add DOB";
      patientDetail.append(button);
    }
  };
  const addDateOfBirth = (): void => {
    requireValue(client && context?.encounter.patientRef && typeof host.encounterSetup?.addDateOfBirth === "function");
    const activeContext = context, activeClient = client, n = generation;
    editorPosition = noteEditorPosition(content, lastEditorField);
    clearNavigation();
    navigation.innerHTML = `<dialog class="provider-unsaved-dialog" aria-labelledby="provider-dob-title"><h2 id="provider-dob-title">Add date of birth</h2><p>${escape(context.encounter.title)}</p><p>Confirm the date with the patient. Recording does not require it.</p><form data-add-dob-form><label>Date of birth<input name="add-dob" type="date" min="1900-01-01" required value="${pendingDateOfBirth?.date ?? ""}"></label><p data-dob-status role="status"></p><button type="submit">Save date of birth</button></form><button data-dob-close>Keep DOB optional</button></dialog>`;
    const dialog = navigation.querySelector<HTMLDialogElement>("dialog")!;
    const date = dialog.querySelector<HTMLInputElement>('input[name="add-dob"]')!;
    const now = new Date(); date.max = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    date.readOnly = pendingDateOfBirth !== null;
    const status = dialog.querySelector<HTMLElement>("[data-dob-status]")!;
    const save = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const close = dialog.querySelector<HTMLButtonElement>("[data-dob-close]")!;
    let writing = false;
    const dismiss = (): void => { if (writing) return; clearNavigation(); restoreNoteEditorPosition(editorPosition); };
    close.addEventListener("click", dismiss);
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.querySelector("form")!.addEventListener("submit", event => {
      event.preventDefault();
      if (writing || !date.reportValidity()) return;
      if (pendingDateOfBirth && pendingDateOfBirth.date !== date.value) { status.textContent = "Check the previous date before changing it. Your request is retained."; return; }
      pendingDateOfBirth ??= { date: date.value, key: crypto.randomUUID() };
      const pending = pendingDateOfBirth;
      writing = true; save.disabled = true; close.disabled = true; date.readOnly = true; status.textContent = "Saving date of birth…";
      void host.encounterSetup!.addDateOfBirth!(activeContext.encounter, pending.date, pending.key, activeClient.signal).then(updated => {
        if (!authorized(n) || context !== activeContext) return;
        requireValue(updated.appointmentRef === activeContext.encounter.appointmentRef && updated.patientRef === activeContext.encounter.patientRef && updated.dateOfBirth === pending.date);
        pendingDateOfBirth = null; renderPatientDetails(updated); writing = false; dismiss();
        notice.textContent = "Date of birth saved.";
      }).catch(() => {
        if (authorized(n) && context === activeContext) status.textContent = "Save is not confirmed. Check your connection and choose Save date of birth again to check the same request.";
      }).finally(() => { writing = false; save.disabled = false; close.disabled = false; });
    });
    dialog.showModal();
  };
  const preparation = (): void => {
    requireValue(context);
    show(`<section class="provider-preparation"><h1>Record this visit</h1><p>${escape(encounterDetail(context.encounter.detail))}</p>
      <div class="provider-recording-fields">
      <label>Visit type<select name="modality">${([ ["in_person", "In person"], ["virtual", "Video visit"], ["phone", "Phone call"] ] as const)
        .map(([value, label]) => `<option value="${value}"${preferredModality === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
      <label>Spoken language<select name="language"><option value="en-US"${preferredLanguage === "en-US" ? " selected" : ""}>English</option><option value="en-US+es-US"${preferredLanguage === "en-US+es-US" ? " selected" : ""}>English and Spanish</option></select></label>
      </div>
      <p class="provider-start-help" data-recording-guidance role="status"></p>
      <details class="provider-recording-options"${isIOS ? "" : " open"}><summary>Audio source<small data-recording-summary></small></summary>
      ${isIOS ? `<label>Microphone<select name="microphone">${microphoneInputs.map(input => `<option value="${input.value}">${input.label}</option>`).join("")}</select><small>Connect an accessory before starting. Check the microphone bars when recording begins.</small></label>` : ""}
      ${isIOS ? "" : `<label>Record audio from<select name="desktop-audio"><option value="microphone"${preferredDesktopAudio === "microphone" ? " selected" : ""}>Microphone only · room or speakerphone</option><option value="meeting"${preferredDesktopAudio === "meeting" ? " selected" : ""}>Microphone + Zoom or Chrome audio</option></select></label><p>Microphone only captures voices audible to this Mac. Application audio also captures the selected app; Chrome can include other tabs and windows.</p>`}
      </details>
      <button data-workspace-action="prepare" aria-describedby="provider-start-consent">Confirm consent &amp; record</button>
      <p class="provider-consent-explanation" id="provider-start-consent">Everyone has agreed to recording and transcription.</p>
      </section>`);
    const options = content.querySelector<HTMLDetailsElement>(".provider-recording-options")!;
    const summarize = (): void => {
      const meeting = !isIOS && input("desktop-audio") === "meeting";
      content.querySelector<HTMLButtonElement>('[data-workspace-action="prepare"]')!.textContent = meeting ? "Confirm consent & choose window" : "Confirm consent & record";
      options.querySelector<HTMLElement>("[data-recording-summary]")!.textContent = isIOS
        ? content.querySelector<HTMLSelectElement>('[name="microphone"]')!.selectedOptions[0]!.textContent
        : input("desktop-audio") === "microphone" ? "Microphone only" : "Microphone + application audio";
      content.querySelector<HTMLElement>("[data-recording-guidance]")!.textContent = isIOS
        ? input("modality") === "in_person" ? "Records the selected iPhone microphone. Check the sound bars when recording begins."
          : "Records the selected iPhone microphone. Call audio is not captured directly; use Scribe on a separate device where both voices can be heard."
        : input("desktop-audio") === "microphone" ? "Records this Mac’s microphone. Keep both voices audible; use speakerphone for a call."
          : "Next, choose the Zoom or Chrome window for this visit. Close unrelated audio in that application.";
    };
    const changed = (event: Event): void => {
      if (!isIOS && (event.target as HTMLElement).getAttribute("name") === "modality") {
        const mode = content.querySelector<HTMLSelectElement>('[name="desktop-audio"]')!;
        mode.value = input("modality") === "virtual" ? "meeting" : "microphone";
      }
      summarize();
    };
    summarize(); content.addEventListener("change", changed);
    disposeContent = () => content.removeEventListener("change", changed);
    consentAction = content.querySelector<HTMLButtonElement>('[data-workspace-action="prepare"]');
  };
  const renewConsent = (): void => {
    const saved = progress();
    requireValue(saved.admission && saved.sessionId === null && !saved.uploaded && saved.pendingSave === null);
    consentRenewalOffered = true;
    const attestation = saved.admission.attestation;
    const visit = { in_person: "In person", virtual: "Video visit", phone: "Phone call" }[attestation.modality];
    show(`<h1>Confirm recording consent</h1><p>Your previous request did not prepare a recording. Confirm that everyone still agrees before continuing.</p>
      <p>${saved.admission.languageMode === "en-US" ? "English" : "English and Spanish"} · ${visit}${attestation.participant_regions.length ? ` · ${escape(attestation.participant_regions.join(", "))}` : ""}</p>
      <label class="provider-consent"><input name="consent" type="checkbox">All parties still agree to recording and transcription.</label>
      <button data-workspace-action="renew-consent">Prepare secure recording</button>`);
  };
  const showReview = (openingView?: CreatorReviewView, initialAction?: "open-draft"): void => {
    requireValue(client && context);
    const n = generation, activeContext = context;
    show("");
    const api = new HttpCreatorReviewApi(session(), client.reviewRequest(session()));
    // recordOrReview just performed this authorized read for the same encounter.
    // Consume it once on mount; refresh/decisions/note handoff still read afresh.
    let first = openingView;
    const dispose = mountCreatorReview(content, {
      read: async signal => {
        const initial = first; first = undefined;
        try { const view = initial ?? await api.read(signal); observeReview(view, n); return view; }
        catch (error) { if (authorized(n) && context === activeContext) recentStates.delete(activeContext.encounter.appointmentRef); throw error; }
      },
      decide: (request, key) => api.decide(request, key),
      edit: (request, key) => api.edit(request, key),
    }, {
      ...(initialAction ? { initialAction } : {}),
      journal: context.reviewJournal(session()), continueToNote: openNotes,
      speakerNameSuggestions: { patient: activeContext.encounter.patientName, clinician: host.providerDisplayName },
      ...(activeContext.playPassage ? { playPassage: activeContext.playPassage } : {}),
      ...(context.editJournal ? { editJournal: context.editJournal(session()) } : {}),
      ...(context.noteOpeningSupported ? { prepareNoteOpening: noteOpeningPreparation() } : {}),
    });
    disposeContent = () => { first = undefined; dispose(); };
  };
  const endOpening = (): void => {
    cancelOpening = null; content.querySelector('[data-workspace-action="cancel-opening"]')?.remove();
  };
  const recordOrReview = async (startRequested?: MicrophoneInput, openingView?: CreatorReviewView, openingSignal?: AbortSignal, initialAction?: "open-draft"): Promise<void> => {
    requireValue(client && context);
    const n = generation, id = session(), activeClient = client, activeContext = context;
    step = "recording status check";
    const view = startRequested !== undefined && host.recorderRechecksReview === true ? null : openingView?.session_id === id ? openingView
      : await interruptibleRead(new HttpCreatorReviewApi(id, activeClient.reviewRequest(id)).read(), openingSignal);
    if (!authorized(n)) return;
    if (view) observeReview(view, n);
    endOpening(); // Recorder ownership or journal mutation starts after this boundary.
    if (view && !["created", "capturing"].includes(view.status)) {
      if (!progress().uploaded) await persist({ ...progress(), uploaded: true });
      if (authorized(n)) showReview(view, initialAction);
      return;
    }
    if (initialAction && view) {
      showReview(view);
      notice.textContent = "A saved draft is not available. Return to Your encounters to open the recording.";
      return;
    }
    const recordingProgress = progress();
    requireValue(!recordingProgress.uploaded && recordingProgress.admission);
    step = "device recording access";
    const acquisition = activeContext.recorder(id, activeClient.signal);
    acquiringRecorder = acquisition;
    let resources: ProviderRecorderResources | PreparedProviderRecorder;
    try { resources = await acquisition; }
    finally { if (acquiringRecorder === acquisition) acquiringRecorder = null; }
    const native = "controller" in resources ? resources : null;
    const local = "flowStore" in resources ? resources : null;
    const localController = local ? new CaptureFlowController({ bff: new CoreCaptureBff(activeClient, id),
      flowStore: local.flowStore, storageCapacity: local.storageCapacity,
      queue: new CaptureQueue(local.queueStorage), source: local.source,
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
      if (view?.status === "capturing" && active === null && preparing === null) throw new CaptureDeviceCustodyError();
      step = "secure recording preparation";
      if (!await localController.restore()) await localController.prepareConfigured(id);
    }
    requireValue(controller.snapshot.sessionId === id);
    if (startRequested !== undefined && native?.controller.selectDesktopAudio) await native.controller.selectDesktopAudio(preferredDesktopAudio);
    if (!authorized(n)) { await close(); return; }
    show("");
    const app = document.createElement("cosmaneura-capture") as CaptureApp;
    app.bindProvider({ sessionId: id, controller, encounterLabel: activeContext.encounter.title,
      visitLabel: { in_person: "In person", virtual: "Video visit", phone: "Phone call" }[recordingProgress.admission.attestation.modality],
      sourceKind: native?.sourceKind ?? local!.source.kind,
      ...(native ? { captureMode: native.captureMode } : {}),
      languageMode: recordingProgress.admission.languageMode === "en-US" ? "english" : "english_spanish",
      authorizedRequest: activeClient.reviewRequest(id), journal: activeContext.reviewJournal(id),
      speakerNameSuggestions: { patient: activeContext.encounter.patientName, clinician: host.providerDisplayName },
      ...(activeContext.playPassage ? { playPassage: activeContext.playPassage } : {}),
      ...(activeContext.editJournal ? { editJournal: activeContext.editJournal(id) } : {}),
      signal: activeClient.signal, deactivate: close, resumePendingUpload: () => lifecycle.resumePendingWork(),
      ...(activeContext.noteOpeningSupported ? { prepareNoteOpening: noteOpeningPreparation(async () => {
        await persist({ ...progress(), uploaded: true });
        await lifecycle.releaseUploadedCapture();
      }) } : {}),
      continueToNote: async (freshView) => {
        if (!authorized(n)) return;
        requireValue(freshView.session_id === id);
        await persist({ ...progress(), uploaded: true });
        await lifecycle.releaseUploadedCapture();
        if (authorized(n)) await openNotes(freshView);
      } });
    content.replaceChildren(app);
    const stopObserving = controller.subscribe(snapshot => {
      if (!authorized(n) || context !== activeContext || snapshot.sessionId !== id) return;
      const status = settledRecorderVisitStatus(snapshot), ref = activeContext.encounter.appointmentRef;
      if (status) recentStates.set(ref, { sessionId: id, status });
      else recentStates.delete(ref); // Starting, errors and unresolved stops invalidate earlier labels.
    });
    disposeContent = () => { stopObserving(); app.remove(); };
    // Only the current explicit Start action carries this in-memory intent.
    // Reopening/recovering a journal never starts a microphone or meeting.
    if (startRequested !== undefined && !(native?.controller.snapshot.desktop?.audioMode === "meeting" && native.controller.snapshot.desktop.meetingWindows)) {
      await app.updateComplete;
      if (authorized(n) && app.isConnected) await app.startFromProviderAction(startRequested);
    }
  };
  const admit = async (mode: "initial" | "recover" | "renew" = "initial", startRequested?: MicrophoneInput): Promise<void> => {
    requireValue(client);
    const n = generation;
    step = "recording admission";
    show(`<h2>Preparing your recording…</h2><p role="status">${startRequested === undefined ? "Restoring your saved visit." : "Checking consent and preparing secure storage. Recording has not started yet."}</p>`);
    const intent = progress().admission;
    requireValue(intent);
    const id = await (mode === "recover" ? client.recoverAdmission(intent)
      : mode === "renew" ? client.renewAdmission(intent) : client.admit(intent));
    if (!authorized(n)) return;
    if (id === null) { renewConsent(); return; }
    requireValue(progress().sessionId === null || progress().sessionId === id);
    if (progress().sessionId === null) await persist({ ...progress(), sessionId: id });
    if (authorized(n)) await recordOrReview(startRequested);
  };
  const open = async (ref: string, initialAction?: "open-draft"): Promise<void> => {
    await clearEncounter(); const n = generation;
    header.hidden = false;
    openingRef = ref; step = "encounter connection";
    show('<h1>Opening encounter</h1><p>Checking access and restoring your saved work…</p><button data-workspace-action="cancel-opening">Cancel opening</button>');
    const opening = new AbortController();
    let cancelled = false;
    const cancel = (): void => { cancelled = true; opening.abort(); };
    cancelOpening = cancel;
    encounterAbort = opening;
    forwardAbort(host.signal, opening);
    try {
      const opened = await interruptibleRead(host.openEncounter(ref, opening.signal), opening.signal);
      if (!current(n)) return;
      requireValue(opened.encounter.appointmentRef === ref && opened.scope.appointmentRef === ref && !opened.signal.aborted);
      context = opened;
      encounterLabel.textContent = opened.encounter.title;
      renderPatientDetails(opened.encounter);
      forwardAbort(opened.signal, opening);
      const signal = opening.signal;
      client = new CoreCaptureClient(opened.scope, opened.request, signal);
      signal.addEventListener("abort", () => {
        if (!current(n) || cancelled) return;
        recentStates.delete(ref);
        void clearEncounter().catch(() => { if (!disposed) notice.textContent = "Recording stop could not be confirmed. Stop it in the native app before continuing."; });
        notice.textContent = "Encounter access ended. Return to your encounters to continue.";
      }, { once: true });
      step = "saved encounter recovery";
      const loaded = await interruptibleRead(opened.journal.load(), opening.signal);
      if (!authorized(n)) return;
      journal = loaded;
      if (recentStates.get(ref)?.sessionId !== loaded.progress?.sessionId) recentStates.delete(ref);
      const first = openingReviewView(opened.openingReview, opened.scope);
      if (loaded.progress) {
        assertProgress(loaded.progress);
        if (loaded.progress.pendingSave) {
          endOpening(); showSaveRecovery();
        } else if (loaded.progress.sessionId) await recordOrReview(undefined, first ?? undefined, opening.signal, initialAction);
        else { endOpening(); show(`<h1>Recover recording preparation</h1><p>Confirm the original request before starting another recording.</p><button data-workspace-action="admit">Retry preparation</button>`); }
      } else {
        const recovered = first === undefined ? await interruptibleRead(client.discoverEncounter(), opening.signal) : first;
        if (!authorized(n)) return;
        endOpening();
        if (recovered === null) {
          if (initialAction) show('<h1>Draft not available</h1><p>Return to Your encounters to open this visit. Recording has not started.</p>');
          else preparation();
        }
        else {
          if (recovered.status === "created" || recovered.status === "capturing") throw new CaptureDeviceCustodyError();
          await persist({ admission: null, sessionId: recovered.session_id, uploaded: true, pendingSave: null });
          if (authorized(n)) showReview(recovered, initialAction);
        }
      }
      if (current(n)) openingRef = null;
    } catch (error) {
      if (!current(n)) return;
      if (!cancelled) throw error;
      await list();
      if (!disposed && !host.signal.aborted) notice.textContent = "Opening cancelled. Your saved work is retained.";
    } finally { if (cancelOpening === cancel) endOpening(); }
  };
  function noteOpeningPreparation(beforeOpen?: () => Promise<void>) {
    requireValue(client && context?.noteOpeningSupported);
    const activeClient = client, n = generation, id = session();
    return async () => {
      const opening = await readNoteOpening(activeClient, id);
      const view = opening?.view ?? await new HttpCreatorReviewApi(id, activeClient.reviewRequest(id)).read();
      requireValue(authorized(n) && client === activeClient && view.session_id === id);
      let consumed = false;
      return { view, open: async () => {
        requireValue(!consumed && authorized(n) && client === activeClient);
        consumed = true;
        await beforeOpen?.();
        if (authorized(n) && client === activeClient) await openNotes(view, opening ?? undefined);
      } };
    };
  }
  async function openNotes(view: CreatorReviewView, opening?: NoteOpening): Promise<void> {
    requireValue(client && context && !client.signal.aborted && view.session_id === session());
    const n = generation;
    observeReview(view, n);
    const currentClient = client;
    requireValue(!opening || opening.view === view && opening.templates !== null);
    // This explicit action owns the fresh coordinated read, when supported.
    // Later template changes, generation and saves retain their fresh reads.
    source = reviewedSource(view);
    if (!progress().uploaded) await persist({ ...progress(), uploaded: true });
    if (!authorized(n)) return;
    templates = opening?.templates ?? await noteTemplates(currentClient, session());
    if (!authorized(n)) return;
    if (templates.length === 1) {
      currentSchema = templates[0]!.schema_ref;
      if (opening) {
        requireValue(opening.draft);
        draft = opening.draft; noteTranscript = view; renderNote();
      } else await readNote(false);
      return;
    }
    if (!templates.length) {
      show('<h1>Your Core note</h1><p>No templates are available. Add a template in Core.</p><button data-workspace-action="review">Review transcript</button><button data-workspace-action="core">Open encounter in Core</button>');
      return;
    }
    show(`<h1>Your Core note</h1><p>The English transcript is ready. Choose your note template.</p>
      <label>Template<select name="schema"><option value="">Choose a template</option>${templates.map(t => `<option value="${escape(t.schema_ref)}">${escape(t.note_type)}</option>`).join("")}</select></label>
      <button data-workspace-action="read">Open note</button>
      <button data-workspace-action="core">Open encounter in Core</button>`);
  }
  const readNote = async (prepare: boolean): Promise<void> => {
    requireValue(client && source && currentSchema);
    const n = generation, activeClient = client, id = session(), schema = currentSchema;
    const review = new HttpCreatorReviewApi(id, activeClient.reviewRequest(id));
    let preparationSource: ReviewedSource | null = null;
    try {
      let view: CreatorReviewView, value: unknown;
      if (prepare) {
        step = "note preparation";
        show('<h1>Preparing your draft note…</h1><p role="status">Checking your transcript. Your recording and transcript are retained.</p>');
        view = await review.read();
        if (!authorized(n)) return;
        // Generation still waits for a fresh, ready transcript before any write.
        preparationSource = reviewedSource(view);
        show('<h1>Preparing your draft note…</h1><p>The draft will appear here when it is ready. Your recording and transcript are retained.</p>');
        value = await activeClient.note(id, "prepare", schema);
      } else {
        // Both reads independently authorize in Core. Wait for both and match
        // their lineage before displaying either; never reuse a cached response.
        [view, value] = await Promise.all([review.read(), activeClient.note(id, "read", schema)]);
      }
      if (!authorized(n)) return;
      const fresh = reviewedSource(view);
      const result = await parseDraft(value, id, schema, fresh);
      if (!authorized(n)) return;
      source = fresh; draft = result; noteTranscript = view;
      if (prepare && result.status === "not_prepared") awaitPreparedNote(n, activeClient, id, schema, fresh);
      else renderNote();
    } catch (error) {
      if (!preparationSource) {
        if (prepare && authorized(n)) renderNote();
        throw error;
      }
      if (authorized(n)) awaitPreparedNote(n, activeClient, id, schema, preparationSource);
    }
  };
  const awaitPreparedNote = (n: number, activeClient: CoreCaptureClient, id: string, schema: string,
    expectedSource: ReviewedSource): void => {
    requireValue(context && authorized(n));
    const activeContext = context;
    // A lost prepare response can follow a committed draft. Recover by reads
    // only; replaying prepare could otherwise start another model operation.
    show('<h1>Waiting for your draft note…</h1><p data-note-readiness role="status">Your draft will appear here automatically when it is ready.</p><p class="provider-note-wait-time" data-note-wait-time aria-live="off">Checking automatically · 0s</p><details class="provider-note-options"><summary>More options</summary><button data-workspace-action="check-note">Check for note</button><button data-workspace-action="review">Review transcript</button><button data-workspace-action="core">Open encounter in Core</button></details>');
    let closed = false, checking = false, expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: AbortController | null = null;
    const startedAt = performance.now(), expiresAt = startedAt + 300_000;
    const status = content.querySelector<HTMLElement>("[data-note-readiness]")!;
    const waitTime = content.querySelector<HTMLElement>("[data-note-wait-time]")!;
    const options = content.querySelector<HTMLDetailsElement>(".provider-note-options")!;
    const button = content.querySelector<HTMLButtonElement>('[data-workspace-action="check-note"]')!;
    const active = (): boolean => !closed && authorized(n) && context === activeContext
      && client === activeClient && currentSchema === schema;
    const updateWaitTime = (): void => {
      if (!active()) return;
      waitTime.textContent = expired ? "Automatic checking paused."
        : `Checking automatically · ${Math.floor((performance.now() - startedAt) / 1000)}s`;
      if (expired) options.open = true;
    };
    const elapsedTimer = setInterval(updateWaitTime, 1000);
    const message = (): void => {
      if (!active()) return;
      status.textContent = expired
        ? "The draft is not confirmed yet. Choose Check for note to look again. Your saved work is retained."
        : "Your draft will appear here automatically when it is ready. You do not need to refresh.";
      updateWaitTime();
    };
    const check = async (automatic = false): Promise<void> => {
      if (!active() || checking || document.visibilityState !== "visible") return;
      if (automatic && (expired || performance.now() >= expiresAt)) { expired = true; message(); return; }
      clearTimeout(timer); checking = true; button.disabled = true;
      const checkStartedAt = performance.now();
      const controller = new AbortController(); reading = controller;
      forwardAbort(activeClient.signal, controller);
      const readClient = new CoreCaptureClient(activeClient.scope, activeContext.request, controller.signal);
      const timeout = setTimeout(() => controller.abort(), automatic ? Math.min(30_000, expiresAt - performance.now()) : 30_000);
      status.textContent = "Checking for your prepared note…";
      // Promise.all may reject while its other GET is still in flight. Abort
      // the observation promptly, but retain the slot until BOTH reads settle.
      let requestsSettled = false, observationSettled = false;
      const release = (): void => {
        if (!requestsSettled || !observationSettled || reading !== controller) return;
        reading = null; checking = false;
        if (active()) {
          button.disabled = false;
          if (!expired && document.visibilityState === "visible") {
            timer = setTimeout(() => { void check(true); }, Math.max(0, 3000 - (performance.now() - checkStartedAt)));
          }
        }
      };
      const reviewRead = new Promise<CreatorReviewView>(resolve => { resolve(new HttpCreatorReviewApi(id, readClient.reviewRequest(id)).read()); });
      const noteRead = new Promise<unknown>(resolve => { resolve(readClient.note(id, "read", schema)); });
      void Promise.allSettled([reviewRead, noteRead]).then(() => { requestsSettled = true; release(); });
      try {
        const [view, value] = await interruptibleRead(Promise.all([reviewRead, noteRead]), controller.signal);
        if (!active() || controller.signal.aborted) return;
        const fresh = reviewedSource(view);
        requireValue(sameSource(fresh, expectedSource));
        const result = await parseDraft(value, id, schema, fresh);
        if (!active() || controller.signal.aborted) return;
        if (result.status === "draft") {
          source = fresh; draft = result; noteTranscript = view; renderNote();
          notice.textContent = "Draft ready. Review and edit it before clinical use.";
          return;
        }
        message();
      } catch {
        if (active() && document.visibilityState === "visible" && controller.signal.reason !== "note-check-hidden") {
          status.textContent = "The note check could not be confirmed. Check your connection, then choose Check for note or review the transcript. Your saved work is retained.";
          expired = true;
          updateWaitTime();
        }
      } finally {
        clearTimeout(timeout); controller.abort();
        observationSettled = true; release();
      }
    };
    const visibility = (): void => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void check(true);
      else reading?.abort("note-check-hidden");
    };
    const deadline = setTimeout(() => { expired = true; clearTimeout(timer); reading?.abort(); message(); }, Math.max(0, expiresAt - performance.now()));
    const manual = (): Promise<void> => check();
    checkPreparedNote = manual;
    document.addEventListener("visibilitychange", visibility);
    disposeContent = () => {
      closed = true; clearTimeout(timer); clearTimeout(deadline); clearInterval(elapsedTimer); reading?.abort();
      document.removeEventListener("visibilitychange", visibility);
      if (checkPreparedNote === manual) checkPreparedNote = null;
    };
    void check(true);
  };
  const renderNote = (): void => {
    requireValue(draft);
    if (context && journal.progress?.sessionId && draft.status === "draft") {
      recentStates.set(context.encounter.appointmentRef, { sessionId: journal.progress.sessionId, status: "draft_ready" });
    }
    const groups = orderedNoteFields(draft.field_order ?? []);
    const field = (key: string): string => `<label>${escape(noteFieldLabel(key))}<textarea data-note-field name="note-${draft!.field_order!.indexOf(key)}" rows="2">${escape(draft!.fields![key]!)}</textarea></label>`;
    show(`<section class="provider-note" data-note-view="note"><div class="provider-note-heading"><h1>${escape(draft.note_type)}</h1>
      <p class="provider-draft-status">${draft.status === "draft" ? "Draft · Clinical review required" : "Your transcript is ready. Prepare a draft note."}</p></div>
      ${draft.reviewed_source.capture_continuity ? '<p role="status">Recording continuity is unconfirmed. Review this note for missing speech; gap lengths are unknown.</p>' : ""}
      ${draft.status === "draft" ? `<div class="provider-save-bar"><p data-note-save-state role="status" aria-atomic="true">Saved · Not clinically reviewed</p><div><button data-workspace-action="save">Save draft</button><button data-workspace-action="finish-note">Save &amp; review in chart</button></div></div>
      <div class="provider-note-tabs" aria-label="Note and conversation"><button data-workspace-action="note-view" aria-pressed="true">Note</button><button data-workspace-action="transcript-view" aria-pressed="false">Transcript</button></div>
      <div class="provider-note-grid"><div class="provider-note-editor" tabindex="0" role="region" aria-label="Draft note">${groups.clinical.map(field).join("")}${groups.details.length ? `<details class="provider-template-details"><summary>Patient and visit details</summary>${groups.details.map(field).join("")}</details>` : ""}</div>
      <aside class="provider-note-evidence"><div class="provider-note-source-toolbar"></div><div data-note-transcript-scroll tabindex="0" role="region" aria-label="Recording transcript">${noteTranscript ? renderNoteTranscript(noteTranscript) : ""}</div></aside></div>`
        : '<button data-workspace-action="generate">Prepare draft note</button><button data-workspace-action="check-note">Check for note</button>'}
      <div class="provider-note-actions"><button data-workspace-action="review">Review transcript</button><button data-workspace-action="core">${draft.status === "draft" ? "Review saved draft in patient chart" : "Open patient chart"}</button></div>
      ${draft.field_order?.some(key => noteFieldLabel(key) !== key) ? `<details class="provider-note-guidance"><summary>Original template headings</summary><p>These headings come from your saved template. Dates and statements in headings do not confirm what happened in this visit.</p><ul>${draft.field_order.filter(key => noteFieldLabel(key) !== key).map(key => `<li>${escape(noteFieldLabel(key))}: ${escape(key)}</li>`).join("")}</ul></details>` : ""}
      <details class="provider-note-guidance"><summary>About this draft</summary><p>Check the note against the conversation and edit anything that is missing or incorrect. Saving preserves your edits; it does not mark the note clinically reviewed.${draft.status === "draft" ? " To complete clinical review, choose Save &amp; review in chart." : ""}</p></details></section>`);
    for (const area of content.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")) {
      const size = (): void => { area.style.height = "auto"; area.style.height = `${Math.max(68, area.scrollHeight + 2)}px`; };
      size(); area.addEventListener("input", size);
    }
    const templateDetails = content.querySelector<HTMLDetailsElement>(".provider-template-details");
    const resizeDetails = (): void => {
      if (templateDetails?.open) for (const area of templateDetails.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")) { area.style.height = "auto"; area.style.height = `${Math.max(68, area.scrollHeight + 2)}px`; }
    };
    templateDetails?.addEventListener("toggle", resizeDetails);
    const transcriptDetails = content.querySelector<HTMLDetailsElement>(".provider-note-evidence details");
    if (transcriptDetails && window.matchMedia("(min-width: 900px)").matches) transcriptDetails.open = true;
    const stopTranscriptTools = bindTranscriptTools(content);
    const n = generation, activeContext = context;
    const sourceNavigation = bindNoteSourceNavigation(content, {
      current: () => authorized(n) && context === activeContext && draft && noteTranscript ? { draft, view: noteTranscript } : null,
      revealTranscript: remember => setNoteView(true, remember), returnToNote: () => setNoteView(false),
    });
    refreshNoteSources = sourceNavigation.refresh;
    content.addEventListener("input", updateSaveState);
    content.addEventListener("focusin", rememberEditorField);
    disposeContent = () => {
      templateDetails?.removeEventListener("toggle", resizeDetails);
      sourceNavigation.dispose();
      if (refreshNoteSources === sourceNavigation.refresh) refreshNoteSources = null;
      stopTranscriptTools(); content.removeEventListener("input", updateSaveState); content.removeEventListener("focusin", rememberEditorField);
    };
  };
  const setNoteView = (transcript: boolean, rememberPosition = true): void => {
    const note = content.querySelector<HTMLElement>(".provider-note");
    requireValue(note);
    if (transcript && rememberPosition) editorPosition = noteEditorPosition(content, lastEditorField);
    note.dataset.noteView = transcript ? "transcript" : "note";
    for (const tab of note.querySelectorAll<HTMLButtonElement>(".provider-note-tabs button")) {
      tab.setAttribute("aria-pressed", String(tab.dataset.workspaceAction === (transcript ? "transcript-view" : "note-view")));
    }
    if (transcript) {
      const details = note.querySelector<HTMLDetailsElement>(".provider-note-evidence details");
      if (details) details.open = true;
      note.querySelector<HTMLElement>('.provider-note-evidence input, .provider-note-evidence summary')?.focus({ preventScroll: true });
    } else restoreNoteEditorPosition(editorPosition);
  };
  const rememberEditorField = (event: FocusEvent): void => {
    if (event.target instanceof HTMLTextAreaElement && event.target.hasAttribute("data-note-field")) lastEditorField = event.target;
  };
  const hasUnsavedEdits = (): boolean => [...content.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")]
    .some(field => field.value !== field.defaultValue);
  const updateSaveState = (): void => {
    refreshNoteSources?.();
    const status = content.querySelector<HTMLElement>("[data-note-save-state]");
    if (status) status.textContent = journal.progress?.pendingSave ? "Save confirmation pending · Edits retained"
      : hasUnsavedEdits() ? "Unsaved edits" : "Saved · Not clinically reviewed";
  };
  const showSaveRecovery = (): void => {
    if (content.querySelector("textarea[data-note-field]")) {
      setNoteEditorPending(content, true); updateSaveState();
      if (!content.querySelector('[data-workspace-action="resolve"]')) {
        const recovery = document.createElement("div"); recovery.className = "provider-save-recovery";
        recovery.innerHTML = '<button data-workspace-action="resolve">Check save status</button>';
        content.querySelector(".provider-save-bar")?.append(recovery);
      }
      restoreNoteEditorPosition(editorPosition);
    } else show('<h1>Confirm your previous save</h1><p>Your exact edits are retained. Checking the saved request automatically…</p><button data-workspace-action="resolve">Check save status</button>');
    startSaveStatusCheck();
  };
  const startSaveStatusCheck = (): void => {
    if (stopSaveCheck || !client || !context || !journal.progress?.pendingSave) return;
    const activeClient = client, activeContext = context, n = generation, pending = journal.progress.pendingSave, id = session();
    let stopped = false, checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: AbortController | null = null;
    const expiresAt = Date.now() + 30_000;
    const active = (): boolean => !stopped && authorized(n) && client === activeClient && context === activeContext && journal.progress?.pendingSave === pending;
    const stop = (): void => { stopped = true; clearTimeout(timer); reading?.abort(); document.removeEventListener("visibilitychange", visible); };
    const check = async (): Promise<void> => {
      if (!active() || checking || document.visibilityState !== "visible" || Date.now() >= expiresAt) return;
      checking = true; reading = new AbortController(); forwardAbort(activeClient.signal, reading);
      const readClient = new CoreCaptureClient(activeClient.scope, activeContext.request, reading.signal);
      const timeout = setTimeout(() => reading?.abort(), Math.min(5000, expiresAt - Date.now()));
      try {
        const result = await interruptibleRead(checkNoteSave(readClient, id, pending), reading.signal);
        if (!active() || reading.signal.aborted) return;
        if (result === "saved") {
          const [view, value] = await interruptibleRead(Promise.all([
            new HttpCreatorReviewApi(id, readClient.reviewRequest(id)).read(), readClient.note(id, "read", pending.schema),
          ]), reading.signal);
          if (!active() || reading.signal.aborted) return;
          const fresh = reviewedSource(view); requireValue(sameSource(fresh, pending.source));
          const saved = await parseDraft(value, id, pending.schema, fresh);
          requireValue(saved.status === "draft" && saved.note_ref !== pending.edit.expected_note_ref
            && saved.source_sha256 === pending.edit.expected_source_sha256
            && JSON.stringify(saved.field_order) === JSON.stringify(pending.fieldOrder)
            && pending.fieldOrder.every(key => saved.fields?.[key] === pending.edit.fields[key]));
          if (!active() || reading.signal.aborted) return;
          await persist({ ...progress(), pendingSave: null });
          if (!authorized(n) || client !== activeClient) return;
          stop(); stopSaveCheck = null; draft = saved; source = fresh; noteTranscript = view; currentSchema = pending.schema;
          notice.textContent = content.querySelector("textarea[data-note-field]") ? ""
            : "Save confirmed. Your saved draft is shown; clinical review is still needed.";
          if (content.querySelector("textarea[data-note-field]")) {
            for (const [i, key] of saved.field_order!.entries()) {
              const field = content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`);
              if (field) { field.defaultValue = saved.fields![key]!; field.value = saved.fields![key]!; }
            }
            content.querySelector(".provider-save-recovery")?.remove(); setNoteEditorPending(content, false); updateSaveState();
            restoreNoteEditorPosition(editorPosition);
          } else renderNote();
        } else if (result === "closed") stop();
      } catch { /* Uncertain reads retain the exact journal and never replay a save. */ }
      finally {
        clearTimeout(timeout); reading?.abort(); reading = null; checking = false;
        if (active() && Date.now() < expiresAt && document.visibilityState === "visible") timer = setTimeout(() => { void check(); }, 2000);
      }
    };
    const visible = (): void => { clearTimeout(timer); if (document.visibilityState === "visible") void check(); else reading?.abort(); };
    document.addEventListener("visibilitychange", visible); stopSaveCheck = stop;
    void check();
  };
  const navigate = async (destination: NavigationDestination): Promise<void> => {
    if (typeof destination === "function") destination();
    else if (destination === "encounters") await list(); else showReview();
  };
  const guardNavigation = async (destination: NavigationDestination): Promise<void> => {
    // The native dialog stays in the viewport while the actual editor remains mounted.
    // Merely requesting navigation never saves or journals note text.
    if (journal.progress?.pendingSave) {
      if (destination === "encounters" || typeof destination === "function") await navigate(destination); else showSaveRecovery();
      return;
    }
    if (!hasUnsavedEdits()) { await navigate(destination); return; }
    editorPosition = noteEditorPosition(content, lastEditorField);
    pendingNavigation = destination;
    navigation.innerHTML = '<dialog class="provider-unsaved-dialog" aria-labelledby="provider-unsaved-title" aria-describedby="provider-unsaved-help"><h2 id="provider-unsaved-title">Keep your note edits?</h2><p id="provider-unsaved-help">Your note has unsaved edits. Save before leaving, or discard these edits.</p><button autofocus data-workspace-action="keep-editing">Keep editing</button><button data-workspace-action="save-and-leave">Save &amp; continue</button><button data-workspace-action="discard-edits">Discard edits and leave</button></dialog>';
    const dialog = navigation.querySelector<HTMLDialogElement>("dialog")!;
    dialog.addEventListener("cancel", event => { event.preventDefault(); clearNavigation(); restoreNoteEditorPosition(editorPosition); });
    dialog.showModal();
  };
  const requestDesktopClose = (event: Event): void => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "function" || disposed || host.signal.aborted) return;
    event.preventDefault();
    const close = event.detail as () => void;
    // A pending save already retains the exact edits in the durable journal.
    // While an unjournaled edit is being saved, leave its editor mounted.
    if (busy && hasUnsavedEdits() && !journal.progress?.pendingSave) {
      notice.textContent = "Your note edits are still being saved. Try Close Scribe again when this finishes.";
      return;
    }
    if (!hasUnsavedEdits() || journal.progress?.pendingSave) close();
    else void run(() => guardNavigation(close));
  };
  const saveCurrentNote = async (): Promise<boolean> => {
    requireValue(client && draft && !progress().pendingSave);
    editorPosition = noteEditorPosition(content, lastEditorField);
    clearNavigation();
    const n = generation;
    const fields = Object.fromEntries(draft.field_order!.map((key, i) => [key, input(`note-${i}`)]));
    const pending = pendingSave(draft, fields);
    setNoteEditorPending(content, true);
    const status = content.querySelector<HTMLElement>("[data-note-save-state]");
    if (status) status.textContent = "Saving your edits…";
    try {
      await persist({ ...progress(), pendingSave: pending });
      const saved = await saveNote(client, session(), pending);
      if (!authorized(n)) return false;
      await persist({ ...progress(), pendingSave: null });
      if (!authorized(n)) return false;
      draft = saved;
      for (const [i, key] of saved.field_order!.entries()) {
        const field = content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`);
        if (field) { field.defaultValue = saved.fields![key]!; field.value = saved.fields![key]!; }
      }
      setNoteEditorPending(content, false); updateSaveState();
      restoreNoteEditorPosition(editorPosition);
      return true;
    } catch (error) {
      if (authorized(n) && !journal.progress?.pendingSave) { setNoteEditorPending(content, false); updateSaveState(); }
      throw error;
    }
  };
  const click = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-workspace-action]") : null;
    if (!button || !root.contains(button)) return;
    // Only a currently displayed read-only opening can bypass the busy guard.
    if (button.dataset.workspaceAction === "cancel-opening") { cancelOpening?.(); return; }
    // Read-only note checks own their cancellation and never block navigation.
    if (button.dataset.workspaceAction === "check-note" && checkPreparedNote) {
      if (!button.disabled) void checkPreparedNote();
      return;
    }
    void run(async () => {
      switch (button.dataset.workspaceAction) {
        case "encounters": await guardNavigation("encounters"); break;
        case "keep-editing": clearNavigation(); restoreNoteEditorPosition(editorPosition); break;
        case "discard-edits": {
          const destination = pendingNavigation;
          clearNavigation();
          if (destination) await navigate(destination);
          break;
        }
        case "create": await host.createEncounter(host.signal); await list(); break;
        case "new-encounter": await setup(); break;
        case "add-dob": addDateOfBirth(); break;
        case "new-patient": showSetup(setupQuery, true); break;
        case "patient-results": selectedCreationPatient = null; showSetup(setupQuery); break;
        case "confirm-create": { requireValue(selectedCreationPatient); const patient = selectedCreationPatient; selectedCreationPatient = null; await create(patient); break; }
        case "hide-visit": {
          const ref = button.dataset.appointment; requireValue(ref && reference(ref, "appointment"));
          const hidden = !hiddenVisits.has(ref);
          await host.encounterSetup?.setHidden?.(ref, hidden, host.signal);
          if (hidden) hiddenVisits.add(ref); else hiddenVisits.delete(ref);
          await list(); notice.textContent = hiddenVisits.has(ref) ? "Visit hidden. The patient chart is retained. Choose Hidden visits to restore it." : "Visit restored."; break;
        }
        case "check-creation": await setup(true); break;
        case "retry-creation": await create(null); break;
        case "select-patient": {
          requireValue(setupState && !setupState.pending);
          const patient = setupState.patients.find(p => p.patientRef === button.dataset.patient);
          requireValue(patient); selectedCreationPatient = { kind: "existing", patientRef: patient.patientRef }; confirmCreation(patient.name); break;
        }
        case "open": await open(button.dataset.appointment!); break;
        case "open-draft": {
          const ref = button.dataset.appointment;
          if (ref && listedDraftRefs.has(ref)) await open(ref, "open-draft");
          break;
        }
        case "prepare": {
          // Only this currently displayed, explicit attestation can initiate a
          // new recording. Reopening or recovering never replays the action.
          if (button !== consentAction || journal.progress !== null) return;
          const language = input("language"), modality = input("modality");
          if (!["en-US", "en-US+es-US"].includes(language) || !["in_person", "virtual", "phone"].includes(modality)) {
            notice.textContent = "Check the spoken language and visit type before continuing."; return;
          }
          const next: ProviderProgress = { admission: { key: crypto.randomUUID(), languageMode: language as LanguageMode,
            attestation: { modality: modality as "in_person" | "virtual" | "phone", participant_regions: [],
              method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } },
          sessionId: null, uploaded: false, pendingSave: null };
          const desktopAudio = content.querySelector<HTMLSelectElement>('[name="desktop-audio"]')?.value;
          if (desktopAudio === "microphone" || desktopAudio === "meeting") preferredDesktopAudio = desktopAudio;
          const microphone = content.querySelector<HTMLSelectElement>('[name="microphone"]')?.value ?? "built_in";
          requireValue(isMicrophoneInput(microphone));
          assertProgress(next); consentAction = null; button.disabled = true; await persist(next);
          preferredLanguage = next.admission.languageMode;
          preferredModality = next.admission.attestation.modality;
          await admit("initial", microphone); break;
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
        case "check-note": requireValue(client && source); awaitPreparedNote(generation, client, session(), currentSchema, source); break;
        case "review": await guardNavigation("review"); break;
        case "note-view": case "transcript-view": {
          setNoteView(button.dataset.workspaceAction === "transcript-view");
          break;
        }
        case "core": requireValue(context); await context.openInCore(draft?.note_ref ?? null); break;
        case "save": await saveCurrentNote(); break;
        case "finish-note": if (await saveCurrentNote()) { requireValue(context); await context.openInCore(draft?.note_ref ?? null); } break;
        case "save-and-leave": {
          const destination = pendingNavigation;
          if (await saveCurrentNote() && destination) await navigate(destination);
          break;
        }
        case "resolve": {
          requireValue(client && progress().pendingSave);
          stopSaveCheck?.(); stopSaveCheck = null;
          editorPosition = noteEditorPosition(content, lastEditorField);
          const n = generation, pending = progress().pendingSave!, activeClient = client, id = session();
          const result = await resolveNote(activeClient, id, pending);
          if (!authorized(n)) return;
          const [view, value] = await Promise.all([
            new HttpCreatorReviewApi(id, activeClient.reviewRequest(id)).read(), activeClient.note(id, "read", pending.schema),
          ]);
          if (!authorized(n)) return;
          const fresh = reviewedSource(view); requireValue(sameSource(fresh, pending.source));
          const confirmed = await parseDraft(value, id, pending.schema, fresh);
          if (!authorized(n)) return;
          const unchanged = confirmed.note_ref === pending.edit.expected_note_ref
            && confirmed.note_sha256 === pending.edit.expected_note_sha256
            && confirmed.source_sha256 === pending.edit.expected_source_sha256;
          const exactSaved = confirmed.status === "draft" && confirmed.note_ref !== pending.edit.expected_note_ref
            && confirmed.source_sha256 === pending.edit.expected_source_sha256
            && JSON.stringify(confirmed.field_order) === JSON.stringify(pending.fieldOrder)
            && pending.fieldOrder.every(key => confirmed.fields?.[key] === pending.edit.fields[key]);
          if (!(result === "saved" && exactSaved || result === "closed" && unchanged)) {
            notice.textContent = "The chart now has a different draft. Your exact edits are still retained. Open the patient chart to compare before resolving this save.";
            showSaveRecovery(); return;
          }
          await persist({ ...progress(), pendingSave: null });
          if (!authorized(n)) return;
          draft = confirmed; source = fresh; currentSchema = pending.schema; noteTranscript = view;
          if (!content.querySelector("textarea[data-note-field]")) renderNote();
          pending.fieldOrder.forEach((key, i) => {
            const field = content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`);
            if (field) { field.defaultValue = confirmed.fields![key]!; field.value = pending.edit.fields[key]!; }
          });
          content.querySelector(".provider-save-recovery")?.remove(); setNoteEditorPending(content, false); updateSaveState();
          restoreNoteEditorPosition(editorPosition);
          notice.textContent = result === "saved" ? "Previous save confirmed. Your saved draft is shown."
            : "The previous save did not complete. Your edits are restored; review and save again.";
          break;
        }
      }
    }, button.dataset.workspaceAction);
  };
  function input(name: string): string {
    return content.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? "";
  }
  let disposing: Promise<void> | null = null;
  const abort = (): void => { void dispose().catch(() => { /* Visible warning; the host can retry disposal. */ }); };
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    if (!disposed) {
      recentStates.clear();
      disposed = true; headerObserver.disconnect(); root.removeEventListener("click", click);
      root.removeEventListener("scribe-desktop-close-request", requestDesktopClose); host.signal.removeEventListener("abort", abort);
      root.replaceChildren();
    }
    disposing = clearEncounter().then(() => { root.replaceChildren(); }).catch(error => {
      root.textContent = "Recording stop could not be confirmed. Stop it in the native app before continuing.";
      disposing = null;
      throw error;
    });
    return disposing;
  };
  root.addEventListener("click", click); root.addEventListener("scribe-desktop-close-request", requestDesktopClose);
  host.signal.addEventListener("abort", abort, { once: true });
  if (host.signal.aborted) abort(); else void run(list, "startup");
  return dispose;
}

function openDraftButton(encounter: ProviderEncounter): string {
  return `<button class="provider-open-draft" data-workspace-action="open-draft" data-appointment="${escape(encounter.appointmentRef)}" aria-label="Open draft for ${escape(encounter.title)}">Open draft</button>`;
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

class RecorderStopUnconfirmed extends Error {}

/** Only use for reads before recorder acquisition or a retained-state write. */
async function interruptibleRead<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Encounter opening cancelled"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([read, cancelled]); }
  finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** Early iOS 17 WebViews lack AbortSignal.any. Keep one owned encounter lifetime. */
function forwardAbort(source: AbortSignal, target: AbortController): void {
  if (target.signal.aborted || source === target.signal) return;
  const abort = (): void => target.abort(source.reason);
  if (source.aborted) { abort(); return; }
  source.addEventListener("abort", abort, { once: true });
  target.signal.addEventListener("abort", () => source.removeEventListener("abort", abort), { once: true });
}
