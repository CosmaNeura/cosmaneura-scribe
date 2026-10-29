import { setupSignInPreparation } from "./signin-preparation";
import "../capture-app";
import { Capacitor } from "@capacitor/core";
import type { CaptureApp } from "../capture-app";
import { isMicrophoneInput, type MicrophoneInput } from "../native/microphone-input";
import type { PreparedProviderRecorder, ProviderRecorderSnapshot } from "../provider-binding";
import { CaptureFlowController } from "../flow";
import { CaptureDeviceCustodyError } from "../capture/device-custody";
import { CaptureQueue } from "../queue/capture-queue";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import { HttpCreatorReviewApi, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { mountCreatorReview, renderNoteTranscript, bindTranscriptTools } from "../../../review-ui/src/creator-review-panel";
import { bindTranscriptPlayback } from "../../../review-ui/src/passage-playback";
import { CoreCaptureBff, CoreCaptureClient, ProviderEncounterRecoveryError, requireValue, reference,
  type LanguageMode } from "./core-client";
import { canonical, noteTemplates, parseDraft, pendingSave, resolveNote, checkNoteSave, reviewedSource, sameSource, saveNote,
  preferredNoteTemplate, type CoreDraft, type CoreNoteTemplate, type PendingNoteSave, type ReviewedSource } from "./core-notes";
import { activeNotePreparation, appendNotePreparationSuccessor, assertProgress, MAX_NOTE_PREPARATION_SUCCESSORS, newerNoteSource, type JournalSnapshot, type ProviderProgress } from "./workspace-journal";
import type { ProviderWorkspaceHost, AuthorizedProviderEncounter, ProviderRecorderResources, ProviderEncounter } from "./workspace-contracts";
export type { ProviderWorkspaceHost, AuthorizedProviderEncounter, ProviderRecorderResources, ProviderEncounter } from "./workspace-contracts";
import "./workspace.css";
import { openingRecoveryReason, openingReviewView } from "./opening-review";
import { encounterSetupMarkup } from "./encounter-setup-view";
import type { EncounterDraft, EncounterSetupState } from "./encounter-setup";
import { readNoteOpening, type NoteOpening } from "./note-opening";
import { beginWorkflowTiming, type WorkflowTimingOutcome } from "./workflow-timing";
import { beginRecordReadyTiming, type RecordReadyTiming } from "./record-ready-timing";
import { encounterTimestamp } from "./workspace-display";
import { noteEditorPosition, restoreNoteEditorPosition, setNoteEditorPending, type NoteEditorPosition } from "./note-editor-state";
import { settledRecorderVisitStatus } from "./recent-visit-state";
import { bindNoteSourceNavigation } from "./note-source-navigation";
import type { PatientIdentity } from "./visit-features";
import { mountPatientMatch } from "./patient-match-view";
import { PrivateNoteSession } from "./private-note-session";
import "./private-note-editor";
import type { PrivateNoteEditor } from "./private-note-editor";
import { draftSaveState, noteConversationView, noteView } from "./note-view";
import { bindNoteSections } from "./note-sections";
import { NoteAutosave } from "./note-autosave";
import { PatientListObserver } from "./patient-list-observer";
import { providerPreferences } from "./provider-preferences";
import { recordingPreparationMarkup } from "./recording-preparation-view";
import { bindPreparationControls } from "./preparation-controls";
import { configureConsentedRecorder, consentPreparationEnabled, type ConsentedSourceChoice } from "./consent-preparation";
import { adjacentVisitDay, bindDaySwipe, visitDay, visitIsOnDay, visitRow } from "./visit-list-view";

/** Product entry for the authorized native/BFF host; default preview never mounts it. */
export function mountProviderWorkspace(root: HTMLElement, host: ProviderWorkspaceHost): () => Promise<void> {
  const isIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  let disposed = false, generation = 0, busy = false;
  let recordingOpenPending = false;
  let recorderBlocksRefresh = false;
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
  let prepareSelectedTemplate = false;
  let consentRenewalOffered = false;
  let consentAction: HTMLButtonElement | null = null;
  let preparationSignIn: ReturnType<typeof setupSignInPreparation> | null = null;
  let preparationControls: ReturnType<typeof bindPreparationControls> | null = null;
  type RecordingAction = Readonly<{ microphone: MicrophoneInput; signal: AbortSignal; desktopAudio?: "microphone" | "meeting"; desktopRecordAction?: "microphone" | "meeting"; meetingWindowId?: string; readyTiming?: RecordReadyTiming }>;
  let pendingRecordingAction: AbortController | null = null;
  let consentPreparationPending = false;
  let consentRecordAction: HTMLButtonElement | null = null;
  let queuedConsentRecord: AbortSignal | null = null;
  let queuedRecordReadyTiming: RecordReadyTiming | undefined;
  let leaveAfterRecordingPreparation = false;
  let openingRef: string | null = null;
  let separateVisitPatientRef: string | null = null;
  let cancelOpening: (() => void) | null = null;
  type NavigationDestination = "encounters" | "review" | (() => void | Promise<void>);
  let pendingNavigation: NavigationDestination | null = null;
  let editorPosition: NoteEditorPosition | null = null;
  let conversationPosition: NoteEditorPosition | null = null;
  let lastEditorField: HTMLTextAreaElement | null = null;
  let noteAutosave: NoteAutosave | null = null;
  let privateNoteSession: PrivateNoteSession | null = null;
  let identityOverride: PatientIdentity | null = null;
  let closePatientMatch: (() => void) | null = null;
  let stagedEditTimer: ReturnType<typeof setTimeout> | undefined;
  let journalWrite: Promise<void> = Promise.resolve();
  let consentPreparationBarrier: Promise<void> | null = null;
  let savedAt: Date | null = null;
  let noteSaveUnconfirmed = false;
  let refreshNoteSources: (() => void) | null = null;
  let stopNotePlayback: (() => void) | null = null;
  let manualUpdatedRetryKey: string | null = null;
  let setupQuery = "";
  let pendingDateOfBirth: { date: string; key: string } | null = null;
  let stopSaveCheck: (() => void) | null = null;
  let step = "request";
  let setupState: EncounterSetupState | null = null;
  const recentStates = new Map<string, { sessionId: string; status: "paused" | "processing" | "recording_saved" | "draft_ready" }>();
  const listedDraftRefs = new Set<string>();
  const hiddenVisits = new Set<string>();
  let listQuery = "", selectedDay = new Date();
  let preferredDesktopAudio: "microphone" | "meeting" = "microphone";
  let preferredLanguage: LanguageMode = "en-US"; // This authorized workspace's lifetime only.
  let preferredModality: "in_person" | "virtual" | "phone" = "in_person";
  let savedPreferences: Awaited<ReturnType<typeof providerPreferences>> | null = null;
  root.classList.add("provider-workspace");
  root.innerHTML = `<p class="provider-account" data-provider-account hidden></p><header class="provider-header" hidden><div><strong>Cosmaneura Scribe</strong><p data-provider-encounter></p><p class="provider-patient-detail" data-provider-patient-detail></p></div><nav class="provider-visit-navigation" aria-label="Visit navigation"><button data-workspace-action="encounters" aria-label="Back to encounters">Back</button><button data-workspace-action="refresh-visit" aria-label="Refresh current visit">Refresh</button></nav></header>
    <p data-workspace-notice role="status"></p><p data-workspace-progress hidden></p><div data-workspace-navigation aria-live="polite"></div><div data-workspace-content></div>`;
  const content = root.querySelector<HTMLElement>("[data-workspace-content]")!;
  const notice = root.querySelector<HTMLElement>("[data-workspace-notice]")!;
  const activity = root.querySelector<HTMLElement>("[data-workspace-progress]")!;
  const navigation = root.querySelector<HTMLElement>("[data-workspace-navigation]")!;
  const encounterLabel = root.querySelector<HTMLElement>("[data-provider-encounter]")!;
  const header = root.querySelector<HTMLElement>(".provider-header")!;
  const accountLabel = root.querySelector<HTMLElement>("[data-provider-account]")!;
  const patientDetail = root.querySelector<HTMLElement>("[data-provider-patient-detail]")!;
  const updateRefresh = (): void => {
    const button = root.querySelector<HTMLButtonElement>('[data-workspace-action="refresh-visit"]');
    if (!button) return;
    button.disabled = busy || recorderBlocksRefresh || !context;
    button.title = recorderBlocksRefresh ? "Finish recording before refreshing this visit" : "Refresh this visit without starting a recording";
  };
  const headerObserver = new ResizeObserver(() => root.style.setProperty("--provider-header-height", `${header.getBoundingClientRect().height}px`));
  headerObserver.observe(header);
  const current = (n: number): boolean => !disposed && !host.signal.aborted && n === generation;
  const authorized = (n: number): boolean => current(n) && context !== null && !client?.signal.aborted;
  const clearNavigation = (): void => {
    pendingNavigation = null; closePatientMatch?.(); closePatientMatch = null; navigation.querySelector<HTMLDialogElement>("dialog")?.close(); navigation.replaceChildren();
  };
  const show = (markup: string): void => { stopSaveCheck?.(); stopSaveCheck = null; clearNavigation(); consentAction = null; disposeContent?.(); disposeContent = null; content.innerHTML = markup; };
  const separatePatient = (): string | null => {
    if (!separateVisitPatientRef || context?.encounter.patientRef !== separateVisitPatientRef) return null;
    const identity = identityOverride ?? context.encounter.identity;
    return identity?.state === "provisional" ? null : identity?.canonicalPatientRef ?? separateVisitPatientRef;
  };
  const showSeparateVisitRecovery = (serverDisposition = false): void => {
    const setup = host.encounterSetup;
    const eligible = separateVisitPatientRef !== null && context?.encounter.patientRef === separateVisitPatientRef && setup;
    const canConfirm = eligible && !separatePatient() && setup.patientMatchJournal && setup.patientCandidates && setup.matchPatient;
    show(`<h1>${serverDisposition ? "Start a separate visit" : "Recording access needed on this device"}</h1><p>${serverDisposition
      ? "This existing visit cannot be continued for recording on this device. Its saved work remains unchanged."
      : "If this recording was prepared on another device, continue on that device. Moving an unfinished recording between devices is not supported. If this is the original device, contact support before retrying. Do not remove Scribe or reset its data."}</p>
      ${eligible ? '<p>You can start a separate visit here for the same patient. The earlier visit and its saved work will stay unchanged. A new recording starts only after you confirm consent.</p>' : ''}
      ${eligible && separatePatient() ? '<button data-workspace-action="new-visit-same-patient">Start a new visit for this patient</button>' : canConfirm ? '<p>Confirm this patient’s identity before starting another visit.</p><button data-workspace-action="confirm-patient-for-new-visit">Confirm patient details</button>' : ''}
      <button data-workspace-action="encounters">Your encounters</button>`);
  };
  const persist = (next: ProviderProgress | ((previous: ProviderProgress) => ProviderProgress)): Promise<void> => {
    requireValue(context && !client?.signal.aborted);
    const activeContext = context, activeClient = client;
    const writing = journalWrite.then(async () => {
      requireValue(context === activeContext && client === activeClient && !activeClient?.signal.aborted);
      const value = typeof next === "function" ? next(progress()) : next;
      const saved = await activeContext.journal.save(journal, value);
      requireValue(context === activeContext && client === activeClient && !activeClient?.signal.aborted);
      journal = saved;
    });
    journalWrite = writing.catch(() => undefined);
    return writing;
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
    separateVisitPatientRef = null;
    queuedRecordReadyTiming?.cancel(); queuedRecordReadyTiming = undefined;
    preparationSignIn?.close(); preparationSignIn = null;
    const controls = preparationControls;
    // A canceled consent flight may still be closing metadata or finishing its
    // encrypted journal write. Join both before releasing this encounter.
    const [closed] = await Promise.allSettled([
      Promise.resolve().then(() => controls?.close()), consentPreparationBarrier,
    ]);
    if (closed.status === "rejected") throw closed.reason;
    preparationControls = null;
    privateNoteSession?.dispose(); privateNoteSession = null; identityOverride = null;
    recorderBlocksRefresh = false; updateRefresh();
    pendingRecordingAction?.abort(); pendingRecordingAction = null; consentPreparationPending = false; consentRecordAction = null; queuedConsentRecord = null; leaveAfterRecordingPreparation = false;
    listedDraftRefs.clear();
    stopSaveCheck?.(); stopSaveCheck = null; pendingDateOfBirth = null;
    clearNavigation();
    encounterAbort?.abort(); encounterAbort = null;
    disposeContent?.(); disposeContent = null;
    content.replaceChildren(); editorPosition = null; conversationPosition = null; lastEditorField = null; savedAt = null; noteSaveUnconfirmed = false; draft = null; source = null; templates = []; noteTranscript = null;
    encounterLabel.textContent = ""; patientDetail.replaceChildren();
    consentRenewalOffered = false;
    consentAction = null;
    openingRef = null;
    cancelOpening = null;
    context = null; client = null; journal = { revision: null, progress: null }; manualUpdatedRetryKey = null;
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
    updateRefresh();
    root.setAttribute("aria-busy", "true");
    const finishTiming = beginWorkflowTiming(timingAction);
    const started = performance.now();
    const activityTimer = setInterval(() => {
      if (disposed || host.signal.aborted) return;
      activity.hidden = !!content.querySelector("cosmaneura-capture");
      activity.textContent = `Working · ${Math.floor((performance.now() - started) / 1000)}s. ${step === "encounter connection"
        ? "Opening this visit." : step === "saved encounter recovery" ? "Restoring saved work."
        : step === "encounter list" ? "Loading today’s patients."
        : step === "recording status check" ? "Checking recording status."
        : step === "device recording access" ? "Connecting this device to the recording."
        : step === "note preparation" ? "Preparing your draft note."
        : step === "recording admission" ? "Preparing secure recording." : "Finishing your request."}`;
    }, 1000);
    let outcome: WorkflowTimingOutcome = "resolved";
    try { await action(); }
    catch (error) {
      outcome = "threw";
      pendingRecordingAction?.abort(); pendingRecordingAction = null;
      if (context) recentStates.delete(context.encounter.appointmentRef);
      if (!disposed && !host.signal.aborted) {
        const preparing = content.querySelector<HTMLElement>("[data-recording-preparation-status]");
        if (preparing && !preparing.hidden) preparing.textContent = "Recording has not started. Preparation could not be confirmed; return to Your encounters and reopen this visit.";
        notice.textContent = error instanceof RecorderStopUnconfirmed
          ? "Recording stop could not be confirmed. Stop it in the native app before continuing."
          : error instanceof CaptureDeviceCustodyError
            ? "This device could not confirm access to the recording key or saved recording state. Your saved work is retained."
          : error instanceof ProviderEncounterRecoveryError
            ? "This existing visit could not be continued for recording. Its saved work remains unchanged."
            : context && journal.progress?.pendingSave
              ? ""
            : step === "encounter setup" || step === "encounter creation"
              ? "Your encounter request could not be confirmed. Check your connection, then check its result. Pending work is retained securely on this device."
            : step === "encounter list"
              ? "Today’s patients could not be loaded. Check your connection, then retry."
            : openingRef
              ? "This visit could not be opened. Your saved work is retained. Retry opening the visit."
              : `The ${step} could not be confirmed. Your saved work is retained. Return to Your encounters and reopen this encounter to recover.`;
        if (error instanceof ProviderEncounterRecoveryError) {
          showSeparateVisitRecovery(true);
        } else if (error instanceof CaptureDeviceCustodyError) {
          showSeparateVisitRecovery();
        } else if (context && journal.progress?.pendingSave) {
          showSaveRecovery();
        } else if (step === "encounter setup" || step === "encounter creation") {
          show('<h1>Check encounter creation</h1><button data-workspace-action="check-creation">Check and continue</button><button data-workspace-action="encounters">Your encounters</button>');
        } else if (openingRef) {
          show(`<h1>Visit could not open</h1><p>Check your connection, then retry opening this visit.</p><button data-workspace-action="open" data-appointment="${escape(openingRef)}">Retry opening visit</button>`);
        } else if (step === "encounter list") {
          show('<h1>Today’s patients</h1><button data-workspace-action="encounters">Retry loading patients</button>');
        }
      }
    } finally {
      clearInterval(activityTimer); activity.hidden = true; activity.textContent = "";
      busy = false; root.removeAttribute("aria-busy");
      updateRefresh();
      finishTiming(disposed || host.signal.aborted ? "cancelled" : outcome);
      if (leaveAfterRecordingPreparation && !disposed && !host.signal.aborted) {
        leaveAfterRecordingPreparation = false;
        void run(() => guardNavigation("encounters"), "encounters");
      }
      flushRecordingOpen();
    }
  };
  const list = async (): Promise<void> => {
    await clearEncounter();
    header.hidden = true; selectedDay = new Date();
    step = "encounter list";
    const n = generation;
    show("<h1>Today’s patients</h1><p>Loading today’s patients…</p>");
    const encounters = await host.listEncounters(host.signal);
    if (!current(n)) return;
    if (!savedPreferences) {
      savedPreferences = await providerPreferences(host.account?.email);
      if (!current(n)) return;
      if (savedPreferences.value) {
        preferredLanguage = savedPreferences.value.language; preferredModality = savedPreferences.value.modality; preferredDesktopAudio = savedPreferences.value.audio;
      }
    }
    if (host.encounterSetup?.hidden) {
      const savedHidden = await host.encounterSetup.hidden(host.signal);
      if (!current(n)) return;
      hiddenVisits.clear(); for (const ref of savedHidden) hiddenVisits.add(ref);
    }
    accountLabel.hidden = !host.providerDisplayName;
    accountLabel.textContent = host.providerDisplayName ?? "";
    const validate = (values: readonly ProviderEncounter[]): void => {
      requireValue(values.length <= 1000 && new Set(values.map(e => e.appointmentRef)).size === values.length);
      for (const e of values) requireValue(reference(e.appointmentRef, "appointment")
        && typeof e.title === "string" && e.title.length <= 300 && typeof e.detail === "string" && e.detail.length <= 1000
        && (e.status === undefined || ["draft_ready", "processing", "paused", "ready", "recording_saved"].includes(e.status)));
    };
    validate(encounters);
    const entries = new Map(encounters.map(entry => [entry.appointmentRef, entry]));
    const ordered = [...encounters].sort((a, b) => (encounterTimestamp(a.detail) ?? Infinity) - (encounterTimestamp(b.detail) ?? Infinity));
    const authorizedRefs = new Set(encounters.map(e => e.appointmentRef));
    for (const ref of recentStates.keys()) if (!authorizedRefs.has(ref)) recentStates.delete(ref);
    const pending = new Set<string>();
    show(`<div class="provider-list-heading"><div><h1 data-day-heading>Today's patients</h1>
      <div class="provider-day-navigation" aria-label="Visit day"><button type="button" data-day-step="-1" aria-label="Previous day">‹</button><span data-day-label></span><button type="button" data-day-step="1" aria-label="Next day">›</button><button type="button" data-day-today hidden>Today</button></div></div>
      ${host.encounterSetup ? '<button class="provider-walk-in" data-workspace-action="new-encounter">+ Walk-in or new patient</button>' : ''}</div>
      ${encounters.length > 8 ? `<label class="provider-list-search">Find a patient<input data-visit-search type="search" placeholder="Patient name" value="${escape(listQuery)}" autocomplete="off"></label>` : ''}
      <ul class="provider-encounters" aria-label="Authorized encounters">${ordered.map(e => {
        const status = e.status === "draft_ready" ? e.status : recentStates.get(e.appointmentRef)?.status ?? e.status;
        if (status === "draft_ready") listedDraftRefs.add(e.appointmentRef);
        if (status === "processing" || status === "recording_saved") pending.add(e.appointmentRef);
        return visitRow(e, status);
      }).join("")}</ul>
      <p data-day-empty hidden>No patients on this day.</p>
      ${host.encounterSetup ? '<button class="provider-text-link" data-workspace-action="new-encounter">Don’t see your patient? Add a walk-in or new patient</button>' : ''}
      <p data-encounter-progress role="status"></p>
      ${hiddenVisits.size ? '<details class="provider-encounter-help"><summary>Details</summary><label><input type="checkbox" data-hidden-visits> Show previously hidden visits</label><div data-hidden-visit-actions></div></details>' : ''}
      <details class="provider-encounter-help"><summary>More</summary><button class="provider-text-link" data-workspace-action="create">Open the dashboard</button></details>
      <p class="provider-support">Still stuck? Email <a href="mailto:dev@cosmaneura.com">dev@cosmaneura.com</a></p>`);
    const controller = new AbortController(); forwardAbort(host.signal, controller);
    const listElement = content.querySelector(".provider-encounters")!;
    const progressLabel = content.querySelector<HTMLElement>("[data-encounter-progress]")!;
    const searchInput = content.querySelector<HTMLInputElement>("[data-visit-search]");
    const showHidden = content.querySelector<HTMLInputElement>("[data-hidden-visits]");
    const filterVisits = (): void => {
      listQuery = searchInput?.value ?? listQuery;
      const query = listQuery.trim().toLocaleLowerCase(), today = new Date(); let visible = 0;
      for (const row of listElement.querySelectorAll<HTMLElement>("[data-visit-ref]")) {
        const ref = row.dataset.visitRef!, entry = entries.get(ref);
        if (!entry) continue;
        row.hidden = !showHidden?.checked && hiddenVisits.has(ref)
          || !!query && !`${entry.title} ${entry.detail}`.toLocaleLowerCase().includes(query)
          || !visitIsOnDay(entry, selectedDay, today);
        if (!row.hidden) visible += 1;
      }
      content.querySelector<HTMLElement>("[data-day-empty]")!.hidden = visible > 0;
      const isToday = visitDay(selectedDay) === visitDay(today);
      content.querySelector<HTMLElement>("[data-day-heading]")!.textContent = isToday ? "Today's patients" : "Patients";
      content.querySelector<HTMLElement>("[data-day-label]")!.textContent = `${new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(selectedDay)} · ${visible} visit${visible === 1 ? "" : "s"}`;
      content.querySelector<HTMLElement>("[data-day-today]")!.hidden = isToday;
      const restores = content.querySelector<HTMLElement>("[data-hidden-visit-actions]");
      if (restores) restores.innerHTML = showHidden?.checked ? [...entries.values()].filter(e => hiddenVisits.has(e.appointmentRef) && visitIsOnDay(e, selectedDay, today)).map(e => `<button class="provider-text-link" data-workspace-action="hide-visit" data-appointment="${escape(e.appointmentRef)}">Restore ${escape(e.title)}</button>`).join("") : "";
    };
    const changeDay = (direction: number): void => { selectedDay = adjacentVisitDay(selectedDay, direction); filterVisits(); };
    const dayClick = (event: MouseEvent): void => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-day-step], [data-day-today]") : null;
      if (!button) return;
      if (button.hasAttribute("data-day-today")) { selectedDay = new Date(); filterVisits(); }
      else changeDay(Number(button.dataset.dayStep));
    };
    const dayKeys = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest(".provider-day-navigation")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); changeDay(event.key === "ArrowLeft" ? -1 : 1); }
    };
    const stopSwipe = bindDaySwipe(content, changeDay);
    searchInput?.addEventListener("input", filterVisits); showHidden?.addEventListener("change", filterVisits); content.addEventListener("click", dayClick); content.addEventListener("keydown", dayKeys); filterVisits();
    const observer = new PatientListObserver({
      active: () => current(n) && !controller.signal.aborted && listElement.isConnected,
      pending: () => pending.size > 0,
      visible: () => document.visibilityState === "visible",
      read: async signal => {
        const reading = new AbortController(); forwardAbort(controller.signal, reading); forwardAbort(signal, reading);
        try { return await host.listEncounters(reading.signal); } finally { reading.abort(); }
      },
      apply: fresh => {
        validate(fresh);
        const freshRefs = new Set(fresh.map(e => e.appointmentRef));
        const removed = [...entries.keys()].filter(ref => !freshRefs.has(ref));
        for (const ref of removed) {
          pending.delete(ref); recentStates.delete(ref); listedDraftRefs.delete(ref); entries.delete(ref);
          [...listElement.querySelectorAll<HTMLElement>("[data-visit-ref]")].find(row => row.dataset.visitRef === ref)?.remove();
        }
        for (const e of fresh) {
          const previous = entries.get(e.appointmentRef);
          // Missing catalog status cannot clear an observed processing state.
          const status = e.status ?? recentStates.get(e.appointmentRef)?.status ?? previous?.status;
          const value = { ...e, ...(status ? { status } : {}) }; entries.set(e.appointmentRef, value);
          if (status === "draft_ready") listedDraftRefs.add(e.appointmentRef); else listedDraftRefs.delete(e.appointmentRef);
          if (status === "processing" || status === "recording_saved") pending.add(e.appointmentRef);
          else { pending.delete(e.appointmentRef); recentStates.delete(e.appointmentRef); }
          const row = [...listElement.querySelectorAll<HTMLElement>("[data-visit-ref]")].find(item => item.dataset.visitRef === e.appointmentRef);
          if (row && JSON.stringify(previous) !== JSON.stringify(value)) row.outerHTML = visitRow(value);
          else if (!row) listElement.insertAdjacentHTML("beforeend", visitRow(value));
        }
        const order = [...entries.values()].sort((a, b) => (encounterTimestamp(a.detail) ?? Infinity) - (encounterTimestamp(b.detail) ?? Infinity));
        for (const e of order) {
          const row = [...listElement.querySelectorAll<HTMLElement>("[data-visit-ref]")].find(item => item.dataset.visitRef === e.appointmentRef);
          if (row) listElement.append(row);
        }
        filterVisits();
        progressLabel.textContent = "";
      },
      unavailable: () => { progressLabel.textContent = "We couldn’t update patients. We’ll try again."; },
    });
    const visibility = (): void => {
      observer.pause(); if (document.visibilityState === "visible") observer.schedule(true);
    };
    controller.signal.addEventListener("abort", () => observer.dispose(), { once: true });
    document.addEventListener("visibilitychange", visibility);
    disposeContent = () => { observer.dispose(); controller.abort(); stopSwipe(); document.removeEventListener("visibilitychange", visibility); searchInput?.removeEventListener("input", filterVisits); showHidden?.removeEventListener("change", filterVisits); content.removeEventListener("click", dayClick); content.removeEventListener("keydown", dayKeys); };
    observer.schedule();
  };
  const setup = async (checkPending = false, existingPatientRef?: string): Promise<void> => {
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
    else if (existingPatientRef && !state.pending) await create({ kind: "existing", patientRef: existingPatientRef });
    else showSetup();
  };
  const create = async (patient: EncounterDraft["patient"] | null, openAfterCreation = true): Promise<void> => {
    requireValue(host.encounterSetup && setupState);
    step = "encounter creation";
    const n = generation;
    const draft: EncounterDraft | null = patient === null ? setupState.pending : {
      creationKey: crypto.randomUUID(), patient, appointmentAt: new Date().toISOString(), title: "Visit",
      ...(!openAfterCreation ? { openAfterCreation: false } : {}),
    };
    requireValue(draft);
    // Recovery follows the durable original choice, never a new button or a
    // default that could mount capture after an uncertain create-only request.
    const shouldOpen = draft.openAfterCreation !== false;
    show(shouldOpen ? '<h1>Opening your visit…</h1><p>Saving the patient’s name. Recording starts after you confirm consent.</p>'
      : '<h1>Creating your visit…</h1><p>Saving the patient’s name.</p>');
    const created = await host.encounterSetup.submit(draft, host.signal);
    if (!current(n)) return;
    if (draft) requireValue(draft.patient.kind === "existing"
      ? created.patientRef === draft.patient.patientRef : created.patientName === draft.patient.name);
    setupState = null;
    if (shouldOpen) await open(created.appointmentRef);
    else show(`<h1>Visit created</h1><p>${escape(created.patientName ?? created.title)}</p>
      <p>To use a Zoom meeting bot, open Schedule in Cosmas, select your meeting, and enable its bot for this visit.</p>
      <p>Creating this visit does not enable a bot or open Scribe recording setup.</p>
      <div class="provider-create-actions"><button data-workspace-action="create">Open dashboard</button><button data-workspace-action="encounters">Today’s patients</button></div>`);
  };
  const showSetup = (query = ""): void => {
    requireValue(setupState); setupQuery = query;
    show(encounterSetupMarkup(setupState, query));
    const form = content.querySelector<HTMLFormElement>("[data-walk-in]");
    const submit = (event: SubmitEvent): void => {
      event.preventDefault(); if (!form?.reportValidity()) return;
      const name = input("walk-in-name").trim();
      if (!name) { notice.textContent = "Enter the patient’s name."; return; }
      const openAfterCreation = !(event.submitter instanceof Element && event.submitter.hasAttribute("data-create-only"));
      void run(() => create({ kind: "new", name, dateOfBirth: null, provisional: true }, openAfterCreation), "create-visit");
    };
    form?.addEventListener("submit", submit);
    disposeContent = () => form?.removeEventListener("submit", submit);
  };
  const renderPatientDetails = (encounter: AuthorizedProviderEncounter["encounter"]): void => {
    patientDetail.replaceChildren();
    const identity = identityOverride ?? encounter.identity;
    const dateOfBirth = identity ? identity.dateOfBirth : encounter.dateOfBirth;
    if (dateOfBirth === undefined || dateOfBirth === null) return;
    const label = document.createElement("span");
    label.textContent = `DOB: ${dateOfBirth}`;
    patientDetail.append(label);
    if (!identity && encounter.dateOfBirth === null && encounter.patientRef && host.encounterSetup?.addDateOfBirth) {
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
    const prepareOnConsent = consentPreparationEnabled(host.consentPreparation);
    show(recordingPreparationMarkup({ isIOS, language: preferredLanguage, modality: preferredModality, audio: preferredDesktopAudio, consentPreparation: prepareOnConsent }));
    const n = generation;
    const warm = setupSignInPreparation(context.signInPreparation,
      () => authorized(n) && journal.progress === null && document.visibilityState === "visible");
    preparationSignIn = warm;
    const controls = bindPreparationControls(content, { isIOS, signal: client!.signal,
      onSetupReady: () => warm.ready(), onSetupInvalidated: () => warm.invalidate(),
      ...(host.audioPreflight ? { open: host.audioPreflight } : {}), remember: value => { savedPreferences?.save(value); },
      ...(prepareOnConsent ? { onConsent: () => {
        if (consentPreparationEnabled(host.consentPreparation)) void run(() => initialConsentPreparation(false), "prepare");
      } } : {}) });
    preparationControls = controls;
    if (controls.ready()) warm.ready();
    disposeContent = () => { warm.close(); if (preparationSignIn === warm) preparationSignIn = null; void controls.close().catch(() => { notice.textContent = "Microphone check could not close. Reopen this visit before recording."; }); };
    consentAction = content.querySelector<HTMLButtonElement>('[data-workspace-action="prepare"]');
  };
  const initialPreparationStatus = (): void => {
    const status = content.querySelector<HTMLElement>("[data-recording-preparation-status]");
    requireValue(status); status.hidden = false;
    status.textContent = consentPreparationPending ? pendingRecordingAction?.signal.aborted
      ? "Recording preparation canceled. Recording has not started. Prepared work is retained."
      : queuedConsentRecord === pendingRecordingAction?.signal
        ? "Preparing secure recording. Your Start request is waiting. Not listening yet."
        : "Preparing secure recording. Not listening yet. You can choose Start recording now or when it is ready."
      : pendingRecordingAction?.signal.aborted
      ? "Recording start canceled. Secure setup may finish without recording."
      : "Preparing your recording… Checking consent and secure storage. Recording has not started yet.";
  };
  const cancelRecordingAction = (): boolean => {
    if (!pendingRecordingAction) return false;
    pendingRecordingAction.abort(); // A leave/cancel click takes effect before the busy guard.
    queuedRecordReadyTiming?.cancel(); queuedRecordReadyTiming = undefined;
    queuedConsentRecord = null;
    if (consentRecordAction) consentRecordAction.disabled = true;
    const status = content.querySelector<HTMLElement>("[data-recording-preparation-status]");
    if (status) status.textContent = consentPreparationPending
      ? "Recording preparation canceled. Recording has not started. Prepared work is retained."
      : "Recording start canceled. Secure setup may finish without recording.";
    const cancel = content.querySelector<HTMLButtonElement>('[data-workspace-action="cancel-recording-action"]');
    if (cancel) cancel.disabled = true;
    return true;
  };
  const showPreparationCanceled = (): void => {
    queuedRecordReadyTiming?.cancel(); queuedRecordReadyTiming = undefined;
    pendingRecordingAction = null; consentPreparationPending = false; queuedConsentRecord = null; consentRecordAction = null;
    show('<h1>Recording preparation canceled</h1><p>Recording has not started. Prepared work is retained. Confirm consent again before recording.</p><button data-workspace-action="admit">Review prepared recording</button>');
  };
  const confirmPreparedConsent = async (n: number): Promise<boolean> => {
    const retained = progress().admission;
    requireValue(retained);
    const pending = new AbortController(); pendingRecordingAction = pending; consentPreparationPending = true;
    const visit = { in_person: "In person", virtual: "Video visit", phone: "Phone call" }[retained.attestation.modality];
    show(`<section class="provider-preparation"><h1>Confirm consent to continue</h1><p>${visit} · ${retained.languageMode === "en-US" ? "English" : "Spanish and English · note in English"}</p>
      <p>Your saved language and visit type are retained. Recording has not started. Confirm that everyone still agrees before recording.</p>
      <label class="provider-consent"><input name="consent" type="checkbox">The patient said yes</label>
      <p>Check the audio source on the next screen, then choose Start recording to turn on the microphone.</p>
      <button data-workspace-action="cancel-recording-action">Cancel</button></section>`);
    const checkbox = content.querySelector<HTMLInputElement>('[name="consent"]')!;
    return new Promise<boolean>(resolve => {
      const finish = (confirmed: boolean): void => {
        content.removeEventListener("change", changed); pending.signal.removeEventListener("abort", abort);
        resolve(confirmed);
      };
      const changed = (event: Event): void => {
        if (event.target === checkbox && checkbox.checked && authorized(n) && document.visibilityState === "visible" && !pending.signal.aborted) finish(true);
      };
      const abort = (): void => finish(false);
      content.addEventListener("change", changed); pending.signal.addEventListener("abort", abort, { once: true });
      disposeContent = () => pending.abort();
    });
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
      journal: context.reviewJournal(session()), continueToNote: (view, afterFinish) => openNotes(view, undefined, afterFinish),
      continueAfterFinish: activeNotePreparation(progress())?.state === "requested",
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
  const recordOrReview = async (startRequested?: RecordingAction, openingView?: CreatorReviewView, openingSignal?: AbortSignal, initialAction?: "open-draft", sourceChoice?: ConsentedSourceChoice, renewedConsent = false): Promise<void> => {
    requireValue(client && context);
    const n = generation, id = session(), activeClient = client, activeContext = context;
    step = "recording status check";
    const view = (startRequested !== undefined || sourceChoice !== undefined) && (host.recorderRechecksReview === true || activeContext.recorderRechecksReview === true) ? null : openingView?.session_id === id ? openingView
      : await interruptibleRead(new HttpCreatorReviewApi(id, activeClient.reviewRequest(id)).read(), openingSignal);
    if (!authorized(n)) return;
    if (view) observeReview(view, n);
    endOpening(); // Recorder ownership or journal mutation starts after this boundary.
    if (view && !["created", "capturing"].includes(view.status)) {
      if (!progress().uploaded) await persist(value => ({ ...value, uploaded: true }));
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
    if (!authorized(n)) { await close(); return; }
    if (!startRequested && !sourceChoice && !renewedConsent && consentPreparationEnabled(host.consentPreparation)
      && ["preparing", "ready", "paused"].includes(controller.snapshot.state)
      && controller.snapshot.recordedChunks === 0 && controller.snapshot.elapsedSeconds === 0) {
      const confirmed = await confirmPreparedConsent(n);
      if (!confirmed || !authorized(n) || pendingRecordingAction?.signal.aborted) {
        await close(); if (authorized(n)) showPreparationCanceled(); return;
      }
      pendingRecordingAction = null; consentPreparationPending = false;
    }
    let recordingAction = startRequested;
    if (sourceChoice) {
      step = "secure recording preparation";
      let configured: boolean;
      try { configured = await configureConsentedRecorder(controller, sourceChoice, () => authorized(n) && context === activeContext && document.visibilityState === "visible"); }
      catch (error) {
        await close();
        if (sourceChoice.signal.aborted || !authorized(n)) { if (authorized(n)) showPreparationCanceled(); return; }
        throw error;
      }
      if (!configured || !authorized(n)) {
        await close();
        if (authorized(n)) showPreparationCanceled();
        return;
      }
      if (queuedConsentRecord === sourceChoice.signal && !sourceChoice.signal.aborted) {
        recordingAction = { ...sourceChoice, ...(queuedRecordReadyTiming ? { readyTiming: queuedRecordReadyTiming } : {}),
          ...(sourceChoice.desktopAudio ? { desktopRecordAction: sourceChoice.desktopAudio } : {}) };
      } else pendingRecordingAction = null;
      queuedRecordReadyTiming = undefined;
      queuedConsentRecord = null; consentRecordAction = null; consentPreparationPending = false;
    }
    show("");
    const app = document.createElement("cosmaneura-capture") as CaptureApp;
    app.bindProvider({ sessionId: id, controller, encounterLabel: activeContext.encounter.identity?.name ?? activeContext.encounter.patientName ?? activeContext.encounter.title,
      ...(host.recordReadyDiagnostic ? { recordReadyDiagnostic: host.recordReadyDiagnostic } : {}),
      visitLabel: { in_person: "In person", virtual: "Video visit", phone: "Phone call" }[recordingProgress.admission.attestation.modality],
      sourceKind: native?.sourceKind ?? local!.source.kind,
      privateNotes: privateNotes(),
      onFinishVisit: () => persist(value => ({ ...value, notePreparation: value.notePreparation ?? { state: "requested", key: crypto.randomUUID(), schema: null, source: null } })),
      ...(native ? { captureMode: native.captureMode } : {}),
      languageMode: recordingProgress.admission.languageMode === "en-US" ? "english" : "english_spanish",
      authorizedRequest: activeClient.reviewRequest(id), journal: activeContext.reviewJournal(id),
      speakerNameSuggestions: { patient: activeContext.encounter.patientName, clinician: host.providerDisplayName },
      ...(activeContext.playPassage ? { playPassage: activeContext.playPassage } : {}),
      ...(activeContext.editJournal ? { editJournal: activeContext.editJournal(id) } : {}),
      signal: activeClient.signal, deactivate: close, resumePendingUpload: () => lifecycle.resumePendingWork(),
      ...(activeContext.noteOpeningSupported ? { prepareNoteOpening: noteOpeningPreparation(async () => {
        await persist(value => ({ ...value, uploaded: true }));
        await lifecycle.releaseUploadedCapture();
      }) } : {}),
      continueToNote: async (freshView, prepareAfterFinish) => {
        if (!authorized(n)) return;
        requireValue(freshView.session_id === id);
        await persist(value => ({ ...value, uploaded: true }));
        await lifecycle.releaseUploadedCapture();
        if (authorized(n)) await openNotes(freshView, undefined, prepareAfterFinish);
      } });
    content.replaceChildren(app);
    const stopObserving = controller.subscribe(snapshot => {
      if (!authorized(n) || context !== activeContext || snapshot.sessionId !== id) return;
      const device = snapshot as ProviderRecorderSnapshot;
      recorderBlocksRefresh = ["recording", "uploading"].includes(snapshot.state)
        || ["stopping", "stop_unconfirmed"].includes(device.desktop?.phase ?? "")
        || ["pausing", "stopPending", "sealing"].includes(device.native?.phase ?? "");
      updateRefresh();
      const status = settledRecorderVisitStatus(snapshot), ref = activeContext.encounter.appointmentRef;
      if (status) recentStates.set(ref, { sessionId: id, status });
      else recentStates.delete(ref); // Starting, errors and unresolved stops invalidate earlier labels.
    });
    disposeContent = () => { stopObserving(); app.remove(); };
    // Only the current consent action carries this in-memory source choice.
    // The explicit microphone button records; meeting preparation waits for Start.
    // Reopening/recovering a journal never starts a microphone or meeting.
    if (recordingAction !== undefined && !recordingAction.signal.aborted) {
      await app.updateComplete;
      if (authorized(n) && app.isConnected && document.visibilityState === "visible") {
        // Visible preparation must not hold the workspace navigation busy guard.
        // The bound view discards this one intent on removal/revocation.
        void app.startFromProviderAction(recordingAction.microphone,
          native?.controller.selectDesktopAudio ? recordingAction.desktopAudio : undefined,
          native?.captureMode === "desktop_meeting" && native.controller.selectDesktopAudio && native.controller.snapshot.desktop
            ? recordingAction.desktopRecordAction : undefined, recordingAction.signal, recordingAction.meetingWindowId, recordingAction.readyTiming)
          .catch(() => { if (authorized(n) && app.isConnected) notice.textContent = "Recording could not start. Check the audio source and recording access, then retry."; })
          .finally(() => { if (pendingRecordingAction?.signal === recordingAction.signal) pendingRecordingAction = null; });
      }
    } else if (pendingRecordingAction?.signal === recordingAction?.signal) pendingRecordingAction = null;
  };
  const admit = async (mode: "initial" | "recover" | "renew" = "initial", startRequested?: RecordingAction, sourceChoice?: ConsentedSourceChoice): Promise<void> => {
    requireValue(client);
    const n = generation;
    step = "recording admission";
    if (mode === "initial" && (startRequested || sourceChoice)) initialPreparationStatus();
    else show("<h2>Preparing your recording…</h2><p role=\"status\">Restoring your saved visit.</p>");
    const intent = progress().admission;
    requireValue(intent);
    if (mode === "initial" && sourceChoice?.signal.aborted) { showPreparationCanceled(); return; }
    const id = await (mode === "recover" ? client.recoverAdmission(intent)
      : mode === "renew" ? client.renewAdmission(intent) : client.admit(intent));
    if (!authorized(n)) return;
    if (id === null) {
      pendingRecordingAction?.abort(); pendingRecordingAction = null; consentPreparationPending = false; queuedConsentRecord = null; consentRecordAction = null;
      renewConsent(); return;
    }
    requireValue(progress().sessionId === null || progress().sessionId === id);
    if (progress().sessionId === null) await persist(value => ({ ...value, sessionId: id }));
    if (authorized(n) && sourceChoice?.signal.aborted) {
      showPreparationCanceled();
    } else if (authorized(n)) await recordOrReview(startRequested, undefined, undefined, undefined, sourceChoice, mode === "renew");
  };
  const initialConsentPreparation = async (recordRequested: boolean, readyTiming?: RecordReadyTiming): Promise<void> => {
    // The fresh checkbox or explicit legacy Start owns this attestation.
    // Recovery never recreates source configuration or recording intent.
    const button = consentAction, n = generation;
    if (!button || document.visibilityState !== "visible" || button !== content.querySelector('[data-workspace-action="prepare"]') || journal.progress !== null || !content.querySelector<HTMLInputElement>('[name="consent"]')?.checked || !preparationControls?.ready()) return;
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
    const preflight = preparationControls?.snapshot();
    pendingRecordingAction = new AbortController();
    preparationSignIn?.handoff(pendingRecordingAction.signal);
    const sourceChoice: ConsentedSourceChoice = Object.freeze({ microphone, signal: pendingRecordingAction.signal,
      ...(preflight?.selectedInputId ? { inputId: preflight.selectedInputId } : {}),
      ...(!isIOS && (desktopAudio === "microphone" || desktopAudio === "meeting") ? { desktopAudio,
          ...(preflight?.meetingWindows?.selectedId ? { meetingWindowId: preflight.meetingWindows.selectedId } : {}) } : {}) });
    const startRequested: RecordingAction | undefined = recordRequested ? { ...sourceChoice, ...(readyTiming ? { readyTiming } : {}),
      ...(sourceChoice.desktopAudio ? { desktopRecordAction: sourceChoice.desktopAudio } : {}) } : undefined;
    consentPreparationPending = !recordRequested;
    consentRecordAction = recordRequested ? null : button;
    queuedConsentRecord = null;
    assertProgress(next); consentAction = null;
    for (const field of content.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(".provider-preparation input, .provider-preparation select, .provider-preparation button")) field.disabled = true;
    if (!recordRequested) {
      button.disabled = false;
      content.querySelector<HTMLInputElement>('[name="consent"]')!.disabled = false;
    }
    const cancel = content.querySelector<HTMLButtonElement>('[data-workspace-action="cancel-recording-action"]');
    if (cancel && (!recordRequested || isIOS || desktopAudio === "microphone")) { cancel.hidden = false; cancel.disabled = false; }
    initialPreparationStatus();
    button.textContent = recordRequested ? "Starting…" : "Start recording";
    const controls = preparationControls;
    // Advisory metadata teardown and the scoped encrypted consent intent are
    // independent. Neither permits admission; join both even when either fails.
    const settling = Promise.allSettled([
      Promise.resolve().then(() => controls?.close()),
      Promise.resolve().then(() => persist(next)),
    ]).then(([closed, saved]) => {
      if (closed.status === "rejected") throw closed.reason;
      if (saved.status === "rejected") throw saved.reason;
    });
    consentPreparationBarrier = settling;
    try { await settling; }
    finally { if (consentPreparationBarrier === settling) consentPreparationBarrier = null; }
    if (preparationControls === controls) preparationControls = null;
    if (!authorized(n)) return;
    if (sourceChoice.signal.aborted) { showPreparationCanceled(); return; }
    disposeContent?.(); disposeContent = null; // Only this completed, current flight can admit.
    preferredLanguage = next.admission.languageMode;
    preferredModality = next.admission.attestation.modality;
    await admit("initial", startRequested, recordRequested ? undefined : sourceChoice);
  };
  const open = async (ref: string, initialAction?: "open-draft"): Promise<void> => {
    await clearEncounter(); const n = generation;
    header.hidden = false;
    openingRef = ref; step = "encounter connection";
    show('<h1>Opening visit</h1><p>Checking access and restoring your saved work…</p><button data-workspace-action="cancel-opening">Cancel opening</button>');
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
      encounterLabel.textContent = opened.encounter.identity?.name ?? opened.encounter.patientName ?? opened.encounter.title;
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
      const prefetchedRecovery = openingRecoveryReason(opened.openingRecovery, opened.scope);
      if (loaded.progress) {
        assertProgress(loaded.progress);
        if (loaded.progress.pendingSave) {
          endOpening(); showSaveRecovery();
        } else if (loaded.progress.sessionId) await recordOrReview(undefined, first ?? undefined, opening.signal, initialAction);
        else { endOpening(); show(`<h1>Recover recording preparation</h1><p>Confirm the original request before starting another recording.</p><button data-workspace-action="admit">Retry preparation</button>`); }
      } else if (prefetchedRecovery) {
        const patientRef = opened.encounter.patientRef;
        if (host.encounterSetup && patientRef && reference(patientRef, "patient")) separateVisitPatientRef = patientRef;
        throw new ProviderEncounterRecoveryError(prefetchedRecovery);
      } else {
        let recovered: CreatorReviewView | null;
        try {
          recovered = first === undefined ? await interruptibleRead(client.discoverEncounter(), opening.signal) : first;
        } catch (error) {
          if (error instanceof ProviderEncounterRecoveryError) {
            const patientRef = opened.encounter.patientRef;
            if (host.encounterSetup && patientRef && reference(patientRef, "patient")) separateVisitPatientRef = patientRef;
          }
          throw error;
        }
        if (!authorized(n)) return;
        endOpening();
        if (recovered === null) {
          if (initialAction) show('<h1>Draft not available</h1><p>This visit has no draft available yet. Return to today’s patients and reopen it to check again.</p>');
          else preparation();
        }
        else {
          if (recovered.status === "created" || recovered.status === "capturing") {
            // Only this authorized, read-only discovery without a local journal
            // may offer a separate visit. It never adopts the earlier recording.
            const patientRef = opened.encounter.patientRef;
            if (host.encounterSetup && patientRef && reference(patientRef, "patient")) separateVisitPatientRef = patientRef;
            throw new CaptureDeviceCustodyError();
          }
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
  async function openNotes(view: CreatorReviewView, opening?: NoteOpening, prepareAfterFinish = false): Promise<void> {
    requireValue(client && context && !client.signal.aborted && view.session_id === session());
    const n = generation;
    observeReview(view, n);
    const currentClient = client;
    requireValue(!opening || opening.view === view && opening.templates !== null);
    // This explicit action owns the fresh coordinated read, when supported.
    // Later template changes, generation and saves retain their fresh reads.
    source = reviewedSource(view);
    if (!progress().uploaded) await persist(value => ({ ...value, uploaded: true }));
    if (!authorized(n)) return;
    const buffered = progress().queuedNoteEdits;
    if (buffered && !sameSource(buffered.source, source)) {
      requireValue(newerNoteSource(buffered.source, source));
      currentSchema = buffered.schema; draft = null; noteTranscript = null;
      showUpdatedPreparation(); return;
    }
    const retainedPreparation = activeNotePreparation(progress());
    if (retainedPreparation?.state === "submitted") {
      requireValue(retainedPreparation.schema && retainedPreparation.source);
      currentSchema = retainedPreparation.schema;
      if (!sameSource(retainedPreparation.source, source)) {
        requireValue(newerNoteSource(retainedPreparation.source, source));
        draft = null; noteTranscript = null;
        showUpdatedPreparation(); return;
      }
      await readNote(false); return;
    }
    prepareAfterFinish = prepareAfterFinish || activeNotePreparation(progress())?.state === "requested";
    prepareSelectedTemplate = prepareAfterFinish;
    templates = opening?.templates ?? await noteTemplates(currentClient, session());
    if (!authorized(n)) return;
    if (templates.length === 1) {
      currentSchema = templates[0]!.schema_ref;
      if (opening) {
        requireValue(opening.draft);
        draft = opening.draft; noteTranscript = view; renderNote();
      } else await readNote(false);
      if (authorized(n) && draft?.status === "not_prepared") {
        const intent = activeNotePreparation(progress());
        if (intent?.state === "submitted" && intent.schema === currentSchema) {
          requireValue(intent.source && sameSource(intent.source, source));
          awaitPreparedNote(n, currentClient, session(), currentSchema, source);
        } else if (prepareAfterFinish) await readNote(true);
      }
      return;
    }
    if (!templates.length) {
      show('<h1>Your visit note</h1><p>No templates are available. Add one in the CosmaNeura dashboard.</p><button data-workspace-action="review">Review transcript</button><button data-workspace-action="core">Open the dashboard</button>');
      return;
    }
    const preferred = await preferredNoteTemplate(currentClient, session(), templates);
    if (!authorized(n)) return;
    show(`<h1>Your visit note</h1><p>${preferred ? "Your default template is selected. You can choose another before opening the note." : "The English transcript is ready. Choose your note template."}</p>
      <label>Template<select name="schema"><option value="">Choose a template</option>${templates.map(t => `<option value="${escape(t.schema_ref)}"${t.schema_ref === preferred ? " selected" : ""}>${escape(t.note_type)}</option>`).join("")}</select></label>
      <button data-workspace-action="read">Open note</button>
      <button data-workspace-action="core">Open the dashboard</button>`);
  }
  const showUpdatedPreparation = (): void => {
    const retained = activeNotePreparation(progress());
    const previous = retained?.source && source && newerNoteSource(retained.source, source) ? retained.source : progress().queuedNoteEdits?.source;
    requireValue(previous && source && newerNoteSource(previous, source));
    const blocked = progress().pendingSave !== null || !!progress().queuedNoteEdits;
    const full = (progress().notePreparationSuccessors?.length ?? 0) >= MAX_NOTE_PREPARATION_SUCCESSORS;
    show(`<h1>Transcript updated</h1><p>Your earlier draft or unsaved edits used transcript version ${previous.working_version}. The current reviewed transcript is version ${source.working_version}. Previous drafts and saved notes are retained.</p>
      <p>${blocked ? "Earlier note edits are unresolved. Resolve them before preparing an updated draft; they will not be applied to this transcript." : full ? "No further updated drafts can be prepared here for this visit. Open the dashboard to review saved notes and continue there." : "Prepare a separate draft from this reviewed transcript. Clinical review will still be required."}</p>
      ${!blocked && !full ? '<button class="provider-primary" data-workspace-action="prepare-updated-note">Prepare updated draft</button>' : ""}
      ${progress().pendingSave ? '<p>The earlier save cannot be applied to the corrected transcript. Check its original status and compare saved work in the dashboard; this screen cannot clear an unconfirmed save.</p><button data-workspace-action="resolve">Check previous save status</button>' : ""}
      ${progress().queuedNoteEdits && !progress().pendingSave ? '<button data-workspace-action="review-retained-edits">Review retained unsaved edits</button>' : ""}
      <button data-workspace-action="review">Review transcript</button><button data-workspace-action="core">Open the dashboard</button>`);
  };
  const readNote = async (prepare: boolean, successor = false, retryUpdated = false): Promise<void> => {
    requireValue(client && source && currentSchema);
    if (prepare && !successor && !retryUpdated && activeNotePreparation(progress())?.state === "submitted") {
      const retained = activeNotePreparation(progress())!;
      requireValue(retained.schema && retained.source && sameSource(retained.source, source));
      currentSchema = retained.schema; await readNote(false); return;
    }
    const n = generation, activeClient = client, id = session(), schema = currentSchema, displayedSource = source;
    let expectedKey = activeNotePreparation(progress())?.key;
    const review = new HttpCreatorReviewApi(id, activeClient.reviewRequest(id));
    let preparationSource: ReviewedSource | null = null, preparationAttempted = false;
    try {
      let view: CreatorReviewView, value: unknown;
      if (prepare) {
        step = "note preparation";
        show('<h1>Preparing your draft note…</h1><p role="status">Checking your transcript. Your recording and transcript are retained.</p>');
        if (retryUpdated) {
          requireValue(expectedKey && manualUpdatedRetryKey === expectedKey && progress().notePreparationSuccessors?.at(-1)?.key === expectedKey
            && progress().pendingSave === null && !progress().queuedNoteEdits);
          manualUpdatedRetryKey = null;
          [view, value] = await Promise.all([review.read(), activeClient.note(id, "read", schema)]);
          if (!authorized(n)) return;
          const checked = reviewedSource(view), retained = activeNotePreparation(progress());
          requireValue(retained?.key === expectedKey && retained.source && sameSource(retained.source, checked)
            && sameSource(displayedSource, checked));
          const existing = await parseDraft(value, id, schema, checked);
          if (!authorized(n)) return;
          requireValue(activeNotePreparation(progress())?.key === expectedKey);
          if (existing.status === "draft") { source = checked; draft = existing; noteTranscript = view; renderNote(); return; }
        } else view = await review.read();
        if (!authorized(n)) return;
        // Generation still waits for a fresh, ready transcript before any write.
        preparationSource = reviewedSource(view);
        if (retryUpdated) {
          requireValue(activeNotePreparation(progress())?.key === expectedKey && progress().pendingSave === null && !progress().queuedNoteEdits);
        } else if (successor) {
          requireValue(sameSource(displayedSource, preparationSource));
          const checkedSource = preparationSource, key = crypto.randomUUID();
          await persist(value => appendNotePreparationSuccessor(value, checkedSource, key));
          expectedKey = key;
        } else {
          const intent = activeNotePreparation(progress()) ?? { state: "requested" as const, key: crypto.randomUUID(), schema: null, source: null };
          await persist(value => ({ ...value, notePreparation: { state: "submitted", key: intent.key, schema, source: preparationSource } }));
          expectedKey = intent.key;
        }
        if (!authorized(n)) return;
        show('<h1>Preparing your draft note…</h1><p>The draft will appear here when it is ready. Your recording and transcript are retained.</p>');
        preparationAttempted = true;
        requireValue(activeNotePreparation(progress())?.key === expectedKey);
        value = await activeClient.note(id, "prepare", schema, undefined, expectedKey);
        // Core prepares its own current source: reject a concurrently advanced
        // source rather than presenting its result as this retained intent.
        if (successor || retryUpdated) view = await review.read();
      } else {
        // Both reads independently authorize in Core. Wait for both and match
        // their lineage before displaying either; never reuse a cached response.
        [view, value] = await Promise.all([review.read(), activeClient.note(id, "read", schema)]);
      }
      if (!authorized(n)) return;
      const fresh = reviewedSource(view);
      requireValue(activeNotePreparation(progress())?.key === expectedKey);
      const retained = activeNotePreparation(progress());
      if (retained?.state === "submitted") requireValue(retained.schema === schema && retained.source && sameSource(retained.source, fresh));
      const result = await parseDraft(value, id, schema, fresh);
      if (!authorized(n)) return;
      requireValue(activeNotePreparation(progress())?.key === expectedKey);
      source = fresh; draft = result; noteTranscript = view;
      if (prepare && result.status === "not_prepared") awaitPreparedNote(n, activeClient, id, schema, fresh);
      else if (result.status === "not_prepared" && activeNotePreparation(progress())?.state === "submitted" && activeNotePreparation(progress())?.schema === schema) awaitPreparedNote(n, activeClient, id, schema, fresh);
      else renderNote();
    } catch (error) {
      if (!preparationSource || !preparationAttempted) {
        if (prepare && authorized(n)) {
          if (successor) showUpdatedPreparation();
          else if (draft) renderNote();
          else if (retryUpdated) awaitPreparedNote(n, activeClient, id, schema, displayedSource);
        }
        throw error;
      }
      if (authorized(n) && activeNotePreparation(progress())?.key === expectedKey) awaitPreparedNote(n, activeClient, id, schema, preparationSource);
    }
  };
  const awaitPreparedNote = (n: number, activeClient: CoreCaptureClient, id: string, schema: string,
    expectedSource: ReviewedSource): void => {
    requireValue(context && authorized(n));
    const activeContext = context, expectedKey = activeNotePreparation(progress())?.key;
    // Automatic recovery is read-only. A newer-source successor may offer a
    // separate explicit same-key retry after paired current not-prepared reads.
    show(`<h1>Recording saved</h1><p class="provider-writing-note">Writing your visit note…</p><p data-note-readiness role="status">Your draft will appear here automatically when it is ready.</p><p class="provider-note-wait-time" data-note-wait-time aria-live="off">Checking automatically · 0s</p><button class="provider-primary" data-workspace-action="encounters">Back to today’s patients</button><details class="provider-note-options"><summary>Details</summary><button data-workspace-action="check-note">Check for note</button><button data-workspace-action="review">Review transcript</button><button data-workspace-action="core">Open the dashboard</button>${progress().notePreparationSuccessors?.at(-1)?.key === expectedKey ? '<button hidden disabled data-workspace-action="retry-updated-note">Retry updated draft</button>' : ""}</details>`);
    let closed = false, checking = false, expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: AbortController | null = null;
    const startedAt = performance.now(), expiresAt = startedAt + 300_000;
    const status = content.querySelector<HTMLElement>("[data-note-readiness]")!;
    const waitTime = content.querySelector<HTMLElement>("[data-note-wait-time]")!;
    const options = content.querySelector<HTMLDetailsElement>(".provider-note-options")!;
    const button = content.querySelector<HTMLButtonElement>('[data-workspace-action="check-note"]')!;
    const active = (): boolean => !closed && authorized(n) && context === activeContext
      && client === activeClient && currentSchema === schema && activeNotePreparation(progress())?.key === expectedKey;
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
      clearTimeout(timer); checking = true; button.disabled = true; manualUpdatedRetryKey = null;
      const retryButton = content.querySelector<HTMLButtonElement>('[data-workspace-action="retry-updated-note"]');
      if (retryButton) retryButton.disabled = true;
      const checkStartedAt = performance.now();
      const controller = new AbortController(); reading = controller;
      forwardAbort(activeClient.signal, controller);
      const readClient = new CoreCaptureClient(activeClient.scope, activeContext.request, controller.signal);
      const timeout = setTimeout(() => controller.abort(), automatic ? Math.min(30_000, expiresAt - performance.now()) : 30_000);
      status.textContent = "Checking for your prepared note…";
      // Promise.all may reject while its other GET is still in flight. Abort
      // the observation promptly, but retain the slot until BOTH reads settle.
      let requestsSettled = false, observationSettled = false, retryReady = false;
      const release = (): void => {
        if (!requestsSettled || !observationSettled || reading !== controller) return;
        reading = null; checking = false;
        if (active()) {
          button.disabled = false;
          if (retryReady) {
            manualUpdatedRetryKey = expectedKey ?? null;
            const retry = content.querySelector<HTMLButtonElement>('[data-workspace-action="retry-updated-note"]');
            if (retry) retry.disabled = false;
          }
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
        if (progress().notePreparationSuccessors?.at(-1)?.key === expectedKey && progress().pendingSave === null && !progress().queuedNoteEdits) {
          retryReady = true;
          status.textContent = "No updated draft is confirmed. An earlier preparation may still finish. You can check again or explicitly retry the same updated request.";
          if (retryButton) { retryButton.hidden = false; retryButton.disabled = true; }
        }
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
  const privateNotes = (): PrivateNoteSession | undefined => {
    if (!context || !client || !journal.progress || !host.encounterSetup?.readPrivateNote || !host.encounterSetup.savePrivateNote) return undefined;
    if (privateNoteSession) return privateNoteSession;
    const n = generation, selected = context, setup = host.encounterSetup;
    privateNoteSession = new PrivateNoteSession({ active: () => authorized(n) && context === selected,
      local: () => journal.progress?.privateNoteState ?? null,
      retain: value => persist(previous => ({ ...previous, privateNoteState: value })),
      read: () => setup.readPrivateNote!(selected.encounter, client!.signal),
      save: (text, version, key) => setup.savePrivateNote!(selected.encounter, text, version, key, client!.signal),
    });
    return privateNoteSession;
  };
  const renderNote = (): void => {
    requireValue(draft);
    const enteringNote = !content.querySelector(".provider-note");
    if (context && journal.progress?.sessionId && draft.status === "draft") {
      recentStates.set(context.encounter.appointmentRef, { sessionId: journal.progress.sessionId, status: "draft_ready" });
    }
    if (draft.status === "not_prepared") { show('<section class="provider-saved-card"><h1>Recording saved</h1><p>Your conversation is ready. Create a draft using your selected template.</p><button class="provider-primary" data-workspace-action="generate">Write visit note</button><details><summary>Details</summary><button class="provider-text-link" data-workspace-action="check-note">Check for note</button><button class="provider-text-link" data-workspace-action="review">Show the conversation</button></details></section>'); return; }
    const identity = identityOverride ?? context?.encounter.identity;
    show(noteView(draft, identity?.name ?? context?.encounter.patientName ?? context?.encounter.title ?? "Visit note", noteTranscript ? renderNoteTranscript(noteTranscript) : "",
      noteTranscript?.working?.segments.some(segment => segment.speaker_role === "unknown") === true));
    conversationPosition = null;
    if (identity && host.encounterSetup?.patientCandidates) content.querySelector(".provider-note-heading")?.insertAdjacentHTML("beforeend", `<button class="provider-text-link" data-workspace-action="match-patient">${identity.state === "provisional" ? "Match patient later" : identity.state === "matched" ? "Patient matched · Details" : "Patient confirmed · Details"}</button>`);
    const privateEditor = content.querySelector<PrivateNoteEditor>("scribe-private-note"); if (privateEditor) privateEditor.port = privateNotes();
    const buffered = journal.progress?.queuedNoteEdits;
    if (buffered && draft.fields && buffered.edit.expected_note_ref === draft.note_ref && buffered.edit.expected_note_sha256 === draft.note_sha256
      && buffered.edit.expected_source_sha256 === draft.source_sha256 && sameSource(buffered.source, draft.reviewed_source)) {
      for (const [i, key] of draft.field_order!.entries()) {
        const area = content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`);
        if (area) area.value = buffered.edit.fields[key]!;
      }
    }
    for (const area of content.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")) {
      const size = (): void => { area.style.height = "auto"; area.style.height = `${Math.max(68, area.scrollHeight + 2)}px`; };
      size(); area.addEventListener("input", size);
    }
    const stopNoteSections = bindNoteSections(content);
    const transcriptDetails = content.querySelector<HTMLDetailsElement>(".provider-note-evidence details");
    if (transcriptDetails && window.matchMedia("(min-width: 900px)").matches) transcriptDetails.open = true;
    const stopTranscriptTools = bindTranscriptTools(content);
    const n = generation, activeContext = context;
    const playback = bindTranscriptPlayback(content, {
      current: () => authorized(n) && context === activeContext && draft ? noteTranscript : null,
      ...(activeContext?.playPassage ? { playPassage: activeContext.playPassage } : {}),
      signal: client?.signal ?? host.signal,
    });
    playback.render(); stopNotePlayback = playback.stop;
    const sourceNavigation = bindNoteSourceNavigation(content, {
      current: () => authorized(n) && context === activeContext && draft && noteTranscript ? { draft, view: noteTranscript } : null,
      revealTranscript: remember => setNoteView(true, remember), returnToNote: () => setNoteView(false),
    });
    refreshNoteSources = sourceNavigation.refresh;
    noteAutosave = new NoteAutosave({ active: () => authorized(n) && context === activeContext,
      dirty: hasUnsavedEdits, save: saveCurrentNote, failed: showSaveRecovery });
    const autosave = noteAutosave;
    content.addEventListener("input", noteChanged);
    if (hasUnsavedEdits()) autosave.changed();
    updateSaveState();
    content.addEventListener("focusin", rememberEditorField);
    disposeContent = () => {
      playback.dispose(); if (stopNotePlayback === playback.stop) stopNotePlayback = null;
      stopNoteSections();
      sourceNavigation.dispose();
      if (refreshNoteSources === sourceNavigation.refresh) refreshNoteSources = null;
      autosave.dispose(); if (noteAutosave === autosave) noteAutosave = null;
      clearTimeout(stagedEditTimer);
      stopTranscriptTools(); content.removeEventListener("input", noteChanged); content.removeEventListener("focusin", rememberEditorField);
    };
    // A newly opened note must not inherit the previous screen's scroll offset.
    // Leave existing note/Conversation editing positions to their restoration path.
    if (enteringNote) content.querySelector(".provider-note")?.scrollIntoView({ block: "start", behavior: "instant" });
  };
  const setNoteView = (transcript: boolean, rememberPosition = true): void => {
    const note = content.querySelector<HTMLElement>(".provider-note");
    requireValue(note);
    if (!transcript) stopNotePlayback?.();
    conversationPosition = noteConversationView(note, transcript, lastEditorField, conversationPosition, rememberPosition);
  };
  const rememberEditorField = (event: FocusEvent): void => {
    if (event.target instanceof HTMLTextAreaElement && event.target.closest(".provider-note-editor, scribe-private-note")) lastEditorField = event.target;
  };
  const hasUnsavedEdits = (): boolean => [...content.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")]
    .some(field => field.value !== field.defaultValue);
  const noteFields = (): Record<string, string> => {
    requireValue(draft?.field_order);
    return Object.fromEntries(draft.field_order.map((key, i) => [key, input(`note-${i}`)]));
  };
  const stageNoteEdits = async (): Promise<void> => {
    clearTimeout(stagedEditTimer);
    if (!draft || !authorized(generation) || !hasUnsavedEdits()) return;
    const edits = pendingSave(draft, noteFields());
    await persist(value => ({ ...value, queuedNoteEdits: edits }));
  };
  const noteChanged = (event: Event): void => {
    if (!(event.target instanceof HTMLTextAreaElement) || !event.target.hasAttribute("data-note-field")) return;
    if (!journal.progress?.pendingSave) noteSaveUnconfirmed = false;
    updateSaveState(); noteAutosave?.changed();
    clearTimeout(stagedEditTimer);
    const n = generation;
    stagedEditTimer = setTimeout(() => { void stageNoteEdits().catch(() => {
      if (!authorized(n)) return;
      noteSaveUnconfirmed = true; updateSaveState(); notice.textContent = "Your edits haven’t saved yet. Keep this note open and try again.";
    }); }, 150);
  };
  const updateSaveState = (): void => {
    refreshNoteSources?.();
    const status = content.querySelector<HTMLElement>("[data-note-save-state]");
    if (status) status.textContent = draftSaveState({ pending: !!journal.progress?.pendingSave,
      dirty: hasUnsavedEdits(), unconfirmed: noteSaveUnconfirmed, savedAt });
  };
  const restoreEditorAfterSave = (): void => {
    // A background save must not move a reader out of Conversation.
    if (content.querySelector<HTMLElement>(".provider-note")?.dataset.conversation !== "shown") restoreNoteEditorPosition(editorPosition);
  };
  const showSaveRecovery = (): void => {
    noteSaveUnconfirmed = true; updateSaveState();
    if (!journal.progress?.pendingSave) {
      notice.textContent = "Your note hasn’t saved yet. Keep it open and try again.";
      if (!content.querySelector('[data-workspace-action="save"]')) content.querySelector(".provider-save-bar")?.insertAdjacentHTML("beforeend", '<button data-workspace-action="save">Try again</button>');
      return;
    }
    if (content.querySelector("textarea[data-note-field]")) {
      setNoteEditorPending(content, true); updateSaveState();
      if (!content.querySelector('[data-workspace-action="resolve"]')) {
        const recovery = document.createElement("div"); recovery.className = "provider-save-recovery";
        recovery.innerHTML = '<button data-workspace-action="resolve">Check save status</button>';
        content.querySelector(".provider-save-bar")?.append(recovery);
      }
      restoreEditorAfterSave();
    } else show('<h1>Confirm your previous save</h1><p>Your exact edits are retained. Checking the saved request automatically…</p><button data-workspace-action="resolve">Check save status</button>');
    startSaveStatusCheck();
  };
  /** A terminal save is past outcome, not permission to display its old draft. */
  const reconcileOlderTerminalSave = async (outcome: "saved" | "closed", pending: PendingNoteSave,
    view: CreatorReviewView, value: unknown, id: string, pendingActive: () => boolean): Promise<boolean> => {
    const fresh = reviewedSource(view);
    if (sameSource(fresh, pending.source)) return false;
    requireValue(newerNoteSource(pending.source, fresh));
    const n = generation, activeContext = context, activeClient = client, intentKey = activeNotePreparation(progress())?.key;
    const active = (): boolean => authorized(n) && context === activeContext && client === activeClient
      && activeNotePreparation(progress())?.key === intentKey;
    // Current receipt is independently validated; no historical fields are copied into it.
    await parseDraft(value, id, pending.schema, fresh);
    if (!active() || !pendingActive()) return true;
    await persist(current => {
      requireValue(active() && pendingActive() && canonical(current.pendingSave) === canonical(pending));
      let buffered = current.queuedNoteEdits;
      if (buffered) requireValue(buffered.schema === pending.schema && sameSource(buffered.source, pending.source)
        && canonical(buffered.fieldOrder) === canonical(pending.fieldOrder)
        && buffered.edit.expected_note_ref === pending.edit.expected_note_ref
        && buffered.edit.expected_note_sha256 === pending.edit.expected_note_sha256
        && buffered.edit.expected_source_sha256 === pending.edit.expected_source_sha256);
      const areas = [...content.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")];
      if (areas.length) {
        requireValue(draft?.schema_ref === pending.schema && draft.note_ref === pending.edit.expected_note_ref
          && draft.note_sha256 === pending.edit.expected_note_sha256 && draft.source_sha256 === pending.edit.expected_source_sha256
          && sameSource(draft.reviewed_source, pending.source) && canonical(draft.field_order) === canonical(pending.fieldOrder)
          && areas.length === pending.fieldOrder.length
          && pending.fieldOrder.every((_, i) => areas.includes(content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`)!)));
        // The readonly editor may contain later typing that beat the staging timer.
        // Submitted values are still dirty until acknowledgement, so compare with the request.
        const fields = noteFields();
        buffered = pending.fieldOrder.every(key => fields[key] === pending.edit.fields[key]) ? null : pendingSave(draft, fields);
      }
      return { ...current, pendingSave: null, queuedNoteEdits: buffered ?? (outcome === "closed" ? pending : null) };
    });
    if (!active() || progress().pendingSave !== null) return true;
    draft = null; noteTranscript = null; source = fresh; currentSchema = pending.schema;
    savedAt = null; noteSaveUnconfirmed = false;
    const retained = activeNotePreparation(progress());
    if (progress().queuedNoteEdits || retained?.source && newerNoteSource(retained.source, fresh)) showUpdatedPreparation();
    else showReview(view);
    notice.textContent = outcome === "saved"
      ? "Your earlier save is confirmed. Saved notes are retained. The corrected transcript needs its own current draft and clinical review."
      : "The earlier save did not complete. Your unsaved edits are retained separately; review or discard them before preparing a corrected draft.";
    return true;
  };
  const startSaveStatusCheck = (): void => {
    if (stopSaveCheck || !client || !context || !journal.progress?.pendingSave) return;
    const activeClient = client, activeContext = context, n = generation, pending = journal.progress.pendingSave, id = session();
    let stopped = false, checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: AbortController | null = null;
    const expiresAt = Date.now() + 30_000;
    const active = (): boolean => !stopped && authorized(n) && client === activeClient && context === activeContext && canonical(journal.progress?.pendingSave) === canonical(pending);
    const stop = (): void => { stopped = true; clearTimeout(timer); reading?.abort(); document.removeEventListener("visibilitychange", visible); };
    const check = async (): Promise<void> => {
      if (!active() || checking || document.visibilityState !== "visible" || Date.now() >= expiresAt) return;
      checking = true; reading = new AbortController(); forwardAbort(activeClient.signal, reading);
      const readClient = new CoreCaptureClient(activeClient.scope, activeContext.request, reading.signal);
      const timeout = setTimeout(() => reading?.abort(), Math.min(5000, expiresAt - Date.now()));
      try {
        const result = await interruptibleRead(checkNoteSave(readClient, id, pending), reading.signal);
        if (!active() || reading.signal.aborted) return;
        if (result === "saved" || result === "closed") {
          const [view, value] = await interruptibleRead(Promise.all([
            new HttpCreatorReviewApi(id, readClient.reviewRequest(id)).read(), readClient.note(id, "read", pending.schema),
          ]), reading.signal);
          if (!active() || reading.signal.aborted) return;
          if (await reconcileOlderTerminalSave(result, pending, view, value, id, () => active() && !!reading && !reading.signal.aborted)) { stop(); stopSaveCheck = null; return; }
          if (result === "closed") { stop(); return; }
          const fresh = reviewedSource(view); requireValue(sameSource(fresh, pending.source));
          const saved = await parseDraft(value, id, pending.schema, fresh);
          requireValue(saved.status === "draft" && saved.note_ref !== pending.edit.expected_note_ref
            && saved.source_sha256 === pending.edit.expected_source_sha256
            && JSON.stringify(saved.field_order) === JSON.stringify(pending.fieldOrder)
            && pending.fieldOrder.every(key => saved.fields?.[key] === pending.edit.fields[key]));
          if (!active() || reading.signal.aborted) return;
          await persist(value => {
            requireValue(active() && reading && !reading.signal.aborted && canonical(value.pendingSave) === canonical(pending));
            return { ...value, pendingSave: null, queuedNoteEdits: value.queuedNoteEdits ? pendingSave(saved, value.queuedNoteEdits.edit.fields) : null };
          });
          if (!authorized(n) || client !== activeClient || context !== activeContext || progress().pendingSave !== null) return;
          draft = saved;
          savedAt = new Date(); noteSaveUnconfirmed = false;
          stop(); stopSaveCheck = null; source = fresh;
          stopNotePlayback?.(); noteTranscript = view; currentSchema = pending.schema;
          notice.textContent = content.querySelector("textarea[data-note-field]") ? ""
            : "Save confirmed. Your saved draft is shown; clinical review is still needed.";
          if (content.querySelector("textarea[data-note-field]")) {
            for (const [i, key] of saved.field_order!.entries()) {
              const field = content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`);
              if (field) { field.defaultValue = saved.fields![key]!; }
            }
            content.querySelector(".provider-save-recovery")?.remove(); setNoteEditorPending(content, false); updateSaveState();
            restoreEditorAfterSave(); if (hasUnsavedEdits()) noteAutosave?.changed();
          } else renderNote();
        }
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
    if (typeof destination === "function") await destination();
    else if (destination === "encounters") await list(); else showReview();
  };
  const guardNavigation = async (destination: NavigationDestination): Promise<void> => {
    if (privateNoteSession && !await privateNoteSession.keepLocal()) { notice.textContent = "Your private reminder hasn’t been retained yet. Keep this visit open and try again."; return; }
    // The native dialog stays in the viewport while the actual editor remains mounted.
    // Merely requesting navigation never saves or journals note text.
    if (journal.progress?.pendingSave) {
      await stageNoteEdits();
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
    cancelRecordingAction();
    const close = event.detail as () => void;
    // A pending save already retains the exact edits in the durable journal.
    // While an unjournaled edit is being saved, leave its editor mounted.
    if (busy && hasUnsavedEdits() && !journal.progress?.pendingSave) {
      notice.textContent = "Your note edits are still being saved. Try Close Scribe again when this finishes.";
      return;
    }
    if (!hasUnsavedEdits()) void (async () => {
      if (privateNoteSession && !await privateNoteSession.keepLocal()) { notice.textContent = "Your private reminder hasn’t been retained yet. Keep Scribe open and try again."; return; }
      if (!disposed && !host.signal.aborted) close();
    })();
    else if (journal.progress?.pendingSave) void (async () => {
      if (privateNoteSession && !await privateNoteSession.keepLocal()) { notice.textContent = "Your private reminder hasn’t been retained yet. Keep Scribe open and try again."; return; }
      await stageNoteEdits();
      if (!disposed && !host.signal.aborted) close();
    })().catch(() => { notice.textContent = "Your latest edits haven’t saved yet. Keep Scribe open and try again."; });
    else void run(() => guardNavigation(close));
  };
  const saveCurrentNote = async (): Promise<boolean> => {
    if (progress().pendingSave) { showSaveRecovery(); return false; }
    requireValue(client && draft);
    if (!hasUnsavedEdits()) return true;
    editorPosition = noteEditorPosition(content, lastEditorField);
    clearNavigation();
    const n = generation;
    const fields = Object.fromEntries(draft.field_order!.map((key, i) => [key, input(`note-${i}`)]));
    const pending = pendingSave(draft, fields);
    clearTimeout(stagedEditTimer);
    noteSaveUnconfirmed = false; updateSaveState();
    try {
      await persist(value => ({ ...value, pendingSave: pending, queuedNoteEdits: null }));
      const saved = await saveNote(client, session(), pending);
      if (!authorized(n)) return false;
      draft = saved;
      await persist(value => ({ ...value, pendingSave: null, queuedNoteEdits: value.queuedNoteEdits ? pendingSave(saved, value.queuedNoteEdits.edit.fields) : null }));
      if (!authorized(n)) return false;
      savedAt = new Date(); noteSaveUnconfirmed = false;
      for (const [i, key] of saved.field_order!.entries()) {
        const field = content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`);
        if (field) { field.defaultValue = saved.fields![key]!; }
      }
      setNoteEditorPending(content, false); updateSaveState();
      return true;
    } catch (error) {
      if (authorized(n)) { noteSaveUnconfirmed = true; if (!journal.progress?.pendingSave) setNoteEditorPending(content, false); updateSaveState(); }
      throw error;
    }
  };
  const click = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-workspace-action]") : null;
    if (!button || !root.contains(button)) return;
    if (button.dataset.workspaceAction === "prepare" && consentPreparationPending) {
      // Only this explicit, current Record click may join the owned consent
      // flight. Readiness, consent and recovered journals never create intent.
      if (button !== consentRecordAction || button.disabled || !authorized(generation) || document.visibilityState !== "visible"
        || !pendingRecordingAction || pendingRecordingAction.signal.aborted
        || !content.querySelector<HTMLInputElement>('[name="consent"]')?.checked) return;
      queuedRecordReadyTiming = beginRecordReadyTiming(host.recordReadyDiagnostic);
      queuedConsentRecord = pendingRecordingAction.signal;
      button.disabled = true; button.textContent = "Starting when ready…"; initialPreparationStatus();
      return;
    }
    if (button.dataset.workspaceAction === "cancel-recording-action") { cancelRecordingAction(); return; }
    if (button.dataset.workspaceAction === "refresh-visit" && (button.disabled || recorderBlocksRefresh || !context)) return;
    if (["encounters", "refresh-visit", "review", "core", "create", "new-encounter", "open", "open-draft"].includes(button.dataset.workspaceAction ?? "")) {
      if (cancelRecordingAction() && busy && button.dataset.workspaceAction === "encounters") {
        leaveAfterRecordingPreparation = true;
        return;
      }
    }
    // Only a currently displayed read-only opening can bypass the busy guard.
    if (button.dataset.workspaceAction === "cancel-opening") { cancelRecordingAction(); cancelOpening?.(); return; }
    // Read-only note checks own their cancellation and never block navigation.
    if (button.dataset.workspaceAction === "check-note" && checkPreparedNote) {
      if (!button.disabled) void checkPreparedNote();
      return;
    }
    if (["prepare-updated-note", "retry-updated-note", "review-retained-edits", "keep-retained-edits", "discard-retained-edits"].includes(button.dataset.workspaceAction ?? "")
      && (button.disabled || button.hidden || button !== content.querySelector(`[data-workspace-action="${button.dataset.workspaceAction}"]`))) return;
    // This explicit initial Record handler precedes admission and recorder creation.
    // Consent-only preparation never starts a recording timing observation.
    const recordReadyTiming = button.dataset.workspaceAction === "prepare" && !consentPreparationEnabled(host.consentPreparation)
      ? beginRecordReadyTiming(host.recordReadyDiagnostic) : undefined;
    void run(async () => {
      switch (button.dataset.workspaceAction) {
        case "encounters": await guardNavigation("encounters"); break;
        case "refresh-visit": {
          if (!context || recorderBlocksRefresh) return;
          const ref = context.encounter.appointmentRef;
          await guardNavigation(() => open(ref));
          break;
        }
        case "keep-editing": clearNavigation(); restoreNoteEditorPosition(editorPosition); break;
        case "discard-edits": {
          const destination = pendingNavigation;
          clearNavigation();
          if (destination) await navigate(destination);
          break;
        }
        case "create": await host.createEncounter(host.signal); await list(); break;
        case "new-encounter": await setup(); break;
        case "new-visit-same-patient": {
          if (button.disabled || button !== content.querySelector('[data-workspace-action="new-visit-same-patient"]')) return;
          const patientRef = separatePatient();
          requireValue(patientRef && host.encounterSetup);
          await setup(false, patientRef); break;
        }
        case "confirm-patient-for-new-visit": {
          if (button.disabled || button !== content.querySelector('[data-workspace-action="confirm-patient-for-new-visit"]')) return;
          requireValue(context && client && separateVisitPatientRef === context.encounter.patientRef && !separatePatient()
            && host.encounterSetup?.patientMatchJournal && host.encounterSetup.patientCandidates && host.encounterSetup.matchPatient);
          const selected = context, activeClient = client, n = generation;
          const matchJournal = await host.encounterSetup.patientMatchJournal(selected.encounter, activeClient.signal);
          if (!authorized(n) || context !== selected || client !== activeClient) return;
          clearNavigation();
          closePatientMatch = mountPatientMatch(navigation, { encounter: selected.encounter, setup: host.encounterSetup, signal: activeClient.signal,
            purpose: "new-visit",
            local: () => matchJournal.local(), retain: value => matchJournal.retain(value),
            updated: identity => { if (authorized(n) && context === selected) {
              identityOverride = identity;
              queueMicrotask(() => { if (authorized(n) && context === selected) showSeparateVisitRecovery(); });
            } },
          });
          break;
        }
        case "add-dob": addDateOfBirth(); break;
        case "new-patient": {
          if (button.disabled || button !== content.querySelector(".provider-create-choice")) return;
          const details = content.querySelector<HTMLElement>("#provider-new-patient");
          if (!details) showSetup(setupQuery);
          else {
            // Hide/show keeps the entered DOB; only Cancel discards this form.
            details.hidden = !details.hidden;
            button.setAttribute("aria-expanded", String(!details.hidden));
            button.textContent = details.hidden ? `Create new patient: ${setupQuery}` : "Hide new patient details";
          }
          if (details?.hidden) button.focus({ preventScroll: true });
          else content.querySelector<HTMLElement>("#provider-new-patient-title")?.focus();
          break;
        }
        case "patient-results":
          showSetup(setupQuery);
          content.querySelector<HTMLButtonElement>(".provider-create-choice")?.focus({ preventScroll: true });
          break;
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
          requireValue(patient);
          if (button.disabled || button !== content.querySelector<HTMLButtonElement>(`[data-workspace-action="select-patient"][data-patient="${patient.patientRef}"]`)) return;
          await create({ kind: "existing", patientRef: patient.patientRef }); break;
        }
        case "open": await open(button.dataset.appointment!); break;
        case "open-draft": {
          const ref = button.dataset.appointment;
          if (ref && listedDraftRefs.has(ref)) await open(ref, "open-draft");
          break;
        }
        case "prepare": await initialConsentPreparation(!consentPreparationEnabled(host.consentPreparation), recordReadyTiming); break;
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
        case "read": currentSchema = input("schema"); requireValue(templates.some(t => t.schema_ref === currentSchema)); await readNote(false); if (prepareSelectedTemplate && draft?.status === "not_prepared") { prepareSelectedTemplate = false; await readNote(true); } break;
        case "generate": await readNote(true); break;
        case "prepare-updated-note": await readNote(true, true); break;
        case "retry-updated-note": await readNote(true, false, true); break;
        case "review-retained-edits": {
          const pending = progress().queuedNoteEdits;
          requireValue(pending && !progress().pendingSave);
          show(`<h1>Retained unsaved note edits</h1><p>These edits belong to transcript version ${pending.source.working_version}. They have not been applied to the corrected transcript. Keep these edits or discard them; previous drafts and saved notes are retained.</p>
            ${pending.fieldOrder.map(field => `<label>${escape(field)}<textarea readonly>${escape(pending.edit.fields[field] ?? "")}</textarea></label>`).join("")}
            <button data-workspace-action="keep-retained-edits">Keep edits</button><button data-workspace-action="discard-retained-edits">Discard these unsaved edits</button>`);
          break;
        }
        case "keep-retained-edits": showUpdatedPreparation(); break;
        case "discard-retained-edits": {
          requireValue(progress().queuedNoteEdits && !progress().pendingSave);
          await persist(value => ({ ...value, queuedNoteEdits: null }));
          if (context && source) {
            const retained = activeNotePreparation(progress());
            if (retained?.source && newerNoteSource(retained.source, source)) showUpdatedPreparation();
            else { requireValue(client); await openNotes(await new HttpCreatorReviewApi(session(), client.reviewRequest(session())).read()); }
          }
          break;
        }
        case "check-note": await readNote(false); break;
        case "review": await guardNavigation("review"); break;
        case "note-view": case "transcript-view": {
          setNoteView(button.dataset.workspaceAction === "transcript-view");
          break;
        }
        case "match-patient": {
          requireValue(context && host.encounterSetup); clearNavigation();
          const selected = context, n = generation;
          closePatientMatch = mountPatientMatch(navigation, { encounter: { ...selected.encounter, ...(identityOverride ? { identity: identityOverride } : {}) }, setup: host.encounterSetup, signal: client!.signal,
            local: () => journal.progress?.pendingPatientMatch ?? null,
            retain: value => persist(previous => ({ ...previous, pendingPatientMatch: value })),
            updated: identity => { if (authorized(n) && context === selected) {
              identityOverride = identity; encounterLabel.textContent = identity.name; renderPatientDetails(selected.encounter);
              const heading = content.querySelector<HTMLElement>(".provider-note-heading h1"); if (heading) heading.textContent = identity.name;
              const conversationPatient = content.querySelector<HTMLElement>(".provider-note-mobile-context"); if (conversationPatient) conversationPatient.textContent = identity.name;
              const match = content.querySelector<HTMLButtonElement>('[data-workspace-action="match-patient"]');
              if (match) match.textContent = identity.state === "provisional" ? "Match patient later" : identity.state === "matched" ? "Patient matched · Details" : "Patient confirmed · Details";
              notice.textContent = "Patient details synced.";
            } },
          });
          break;
        }
        case "core": requireValue(context); await context.openInCore(draft?.note_ref ?? null); break;
        case "save": await noteAutosave?.flush(); break;
        case "finish-note": if (await noteAutosave?.flush() && (!privateNoteSession || await privateNoteSession.retry())) {
          requireValue(context && draft?.note_ref && authorized(generation));
          show('<section class="provider-completion"><p class="provider-completion-check" aria-hidden="true">✓</p><h1>Saved for review</h1><p>Your note is saved. Open the dashboard to review it; you may need to sign in.</p><button class="provider-primary" data-workspace-action="core">Open the dashboard</button><button class="provider-text-link" data-workspace-action="encounters">Back to today’s patients</button></section>');
        } break;
        case "save-and-leave": {
          const destination = pendingNavigation;
          if (await noteAutosave?.flush() && destination) await navigate(destination);
          break;
        }
        case "resolve": {
          requireValue(client && progress().pendingSave);
          stopSaveCheck?.(); stopSaveCheck = null;
          editorPosition = noteEditorPosition(content, lastEditorField);
          const n = generation, pending = progress().pendingSave!, activeClient = client, activeContext = context, id = session();
          const active = (): boolean => authorized(n) && client === activeClient && context === activeContext
            && canonical(journal.progress?.pendingSave) === canonical(pending);
          const result = await resolveNote(activeClient, id, pending);
          if (!active()) return;
          const [view, value] = await Promise.all([
            new HttpCreatorReviewApi(id, activeClient.reviewRequest(id)).read(), activeClient.note(id, "read", pending.schema),
          ]);
          if (!active()) return;
          if (await reconcileOlderTerminalSave(result, pending, view, value, id, active)) break;
          const fresh = reviewedSource(view); requireValue(sameSource(fresh, pending.source));
          const confirmed = await parseDraft(value, id, pending.schema, fresh);
          if (!active()) return;
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
          const retainedFields = journal.progress?.queuedNoteEdits?.edit.fields ?? pending.edit.fields;
          await persist(value => {
            requireValue(active() && canonical(value.pendingSave) === canonical(pending));
            return { ...value, pendingSave: null, queuedNoteEdits: pendingSave(confirmed, retainedFields) };
          });
          if (!authorized(n) || client !== activeClient || context !== activeContext || progress().pendingSave !== null) return;
          draft = confirmed;
          source = fresh; currentSchema = pending.schema;
          stopNotePlayback?.(); noteTranscript = view;
          noteSaveUnconfirmed = false; if (result === "saved") savedAt = new Date();
          if (!content.querySelector("textarea[data-note-field]")) renderNote();
          pending.fieldOrder.forEach((key, i) => {
            const field = content.querySelector<HTMLTextAreaElement>(`[name="note-${i}"]`);
            if (field) { field.defaultValue = confirmed.fields![key]!; field.value = retainedFields[key]!; }
          });
          content.querySelector(".provider-save-recovery")?.remove(); setNoteEditorPending(content, false); updateSaveState();
          restoreEditorAfterSave(); if (hasUnsavedEdits()) noteAutosave?.changed();
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
  const consentChanged = (event: Event): void => {
    if (event.target === content.querySelector('[name="consent"]')
      && !content.querySelector<HTMLInputElement>('[name="consent"]')?.checked) preparationSignIn?.invalidate();
    if (consentPreparationPending && event.target === content.querySelector('[name="consent"]')
      && !content.querySelector<HTMLInputElement>('[name="consent"]')?.checked) cancelRecordingAction();
  };
  const foregroundChanged = (): void => {
    if (document.visibilityState !== "visible") preparationSignIn?.invalidate();
    else if (preparationControls?.ready()) preparationSignIn?.ready();
    if (document.visibilityState !== "visible" && pendingRecordingAction) cancelRecordingAction();
  };
  let disposing: Promise<void> | null = null;
  const returnToRecording = async (): Promise<void> => {
    const mounted = content.querySelector<HTMLElement>("cosmaneura-capture");
    if (mounted && closeRecorder && authorized(generation)) {
      mounted.tabIndex = -1; mounted.scrollIntoView({ block: "start" }); mounted.focus({ preventScroll: true });
      return;
    }
    const selected = await host.activeRecording?.(host.signal);
    if (!selected) { notice.textContent = "This recording is no longer active. Open the visit to review your saved work."; return; }
    await guardNavigation(async () => {
      await open(selected.appointmentRef); // No Start, Resume or admission action.
      if (authorized(generation)) requireValue(journal.progress?.sessionId === selected.sessionId);
    });
  };
  const flushRecordingOpen = (): void => {
    if (!recordingOpenPending || disposed || host.signal.aborted || busy) return;
    recordingOpenPending = false;
    void run(returnToRecording, "recording-return");
  };
  const requestRecordingOpen = (): void => { recordingOpenPending = true; flushRecordingOpen(); };
  const abort = (): void => { void dispose().catch(() => { /* Visible warning; the host can retry disposal. */ }); };
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    if (!disposed) {
      recentStates.clear();
      disposed = true; headerObserver.disconnect(); root.removeEventListener("click", click);
      root.removeEventListener("change", consentChanged);
      document.removeEventListener("visibilitychange", foregroundChanged);
      root.removeEventListener("scribe-desktop-close-request", requestDesktopClose); host.signal.removeEventListener("abort", abort);
      root.removeEventListener("scribe-open-recording", requestRecordingOpen);
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
  root.addEventListener("change", consentChanged);
  document.addEventListener("visibilitychange", foregroundChanged);
  root.addEventListener("scribe-open-recording", requestRecordingOpen);
  host.signal.addEventListener("abort", abort, { once: true });
  if (host.signal.aborted) abort(); else void run(list, "startup");
  return dispose;
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
