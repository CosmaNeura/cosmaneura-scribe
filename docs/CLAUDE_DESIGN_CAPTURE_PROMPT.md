# Prompt to push to Claude Design — capture companion visual design

Written 2026-08-17 against `main`. This produces the **visual design canvas** for the
`apps/capture/` companion (ADR 0018) ahead of the Codex build rounds in
`CODEX_MOBILE_CAPTURE_PROMPT.md`. The canvas output (PNG exports + a written design spec) is a
Phase 2 input for Codex, not a binding contract — ADRs 0011/0016/0018 and `CLAUDE.md` always win
where they conflict.

Paste everything between the rules into Claude Design.

---

## Mission

Design the screens for a mobile-first ambient clinical capture companion for private practice
physicians — think **Granola for the exam room and the telehealth visit**: the physician stays
fully present with the patient while the app quietly captures the visit, and the "note magic"
happens after, not during. The deliverable is a multi-artboard canvas covering the full flow at
phone size (390×844), plus one tablet artboard for the exam-room kiosk case.

## Who this is for (do not design for a generic "doctor")

The customer is a faith-driven private practice or small telehealth network physician — the
concrete reference customer is a ~300-provider Catholic telehealth network:

- They practice across specialties, mostly **telehealth video visits**, some in-person. They are
  not tech-forward; the app must feel as simple as a phone call.
- Their unpaid evenings are spent on documentation. Notes must be completed within **24–48 hours**
  or the visit isn't billable. Missing structured facts — visit length, place of service, patient
  location, consent confirmation — are the top reason notes fail billing review.
- They are mission-driven and relationship-centered: the visit is a personal, often pastoral
  encounter. Anything that makes the patient feel surveilled or the physician feel like a data
  clerk is a design failure. Tone: calm, warm, reverent of the encounter; never gamified, never
  "AI-magic" flashy.
- Trust is the product. Consent, recording state, and "where is my audio going" must always be
  legible at a glance. This differentiates us from the EHR vendor's built-in ambient AI
  (athenahealth is shipping one): we are the scribe that respects the encounter and the
  physician's conscience.

## What the app actually does (fixed scope — do not invent features)

The flow ends at a **read-only transcript**. Note drafting, coding, and billing live in the main
Cosmaneura platform, not here. Screens to design, in order:

1. **Sign-in** — single "Continue with your practice account" action (platform SSO). No local
   passwords, no self-serve signup.
2. **Home / visit list** — today's captures: each card shows patient-free labels (session
   time, duration, status chip: `Recording`, `Uploading`, `Waiting for consent`, `Transcribing`,
   `Transcript ready`, `Delivered to notes`, `Needs attention`). One primary action: **New visit
   capture**. Show an offline banner state ("Recording safe on this device — will upload when
   back online").
3. **Consent gate** — this precedes every recording, always. All-party consent: a short spoken
   script the physician reads, a single confirm control recording who consented and how
   (verbal in-visit / documented prior consent), and a clearly separate decline path that ends the
   flow. Consent must feel like a dignified ritual, not a EULA. This screen is the soul of the
   product — spend design effort here.
4. **Recording** — the Granola moment. Near-empty screen: elapsed time, a quiet waveform or
   breathing indicator, giant unambiguous **recording state** (also visible at a glance across the
   room), pause/resume, and **End visit**. Optional minimal marker button ("flag a moment") — no
   live transcript, no live notes, nothing to read or type during the visit. Design lock-screen /
   backgrounded and interrupted (incoming call) states.
5. **Upload & processing** — after End visit: chunked encrypted upload progress, then a
   transcription-in-progress state with honest expectations ("usually ready in a few minutes").
   Include the failure/retry state ("Needs attention") — one-tap retry, never data loss language.
6. **Transcript view (read-only)** — clean diarized transcript: speaker-role labels
   (Clinician / Patient / Other), timestamps, confidence flagged only where low, search within
   transcript. Prominent single handoff status: "Delivered to your Cosmaneura notes ✓". No edit
   affordances — link out to the platform for the note itself.
7. **Settings** — minimal: audio input, default consent script per practice, purge local
   recordings, sign out. Include the tenant/practice name so a locum covering two practices always
   knows which tenant they're in.
8. **Tablet artboard** — exam-room kiosk variant of screens 3–4: bigger consent affordance
   readable by the patient, recording state visible from patient's side of the desk.

## Design constraints and voice

- **Privacy-visible by design.** The recording state must never be ambiguous. Show, somewhere
  calm but persistent, that audio is encrypted on device before upload. Never display patient
  names or DOBs in list views or notifications — sessions are identified by time and physician's
  own optional nickname ("post-lunch follow-up").
- **One-hand, glanceable, interruptible.** Physicians tap between patients, in hallways, mid-call.
  Primary actions bottom-third, large targets, no nested menus on the critical path.
- **Visual language:** unhurried and clinical-calm — generous whitespace, a warm neutral base
  with one deep accent (Cosmaneura brand if available; otherwise a deep teal/navy), humanist
  sans, soft depth, no glassmorphism, no consumer-health cheerfulness. It should feel like a
  well-made instrument, closer to a stethoscope than a startup app. Both light and dark (dark
  matters for dim exam rooms and evening use).
- **States are the design.** For every screen, the loading / offline / error / empty states are
  first-class artboards or callouts, not afterthoughts — Codex will build exactly what's drawn.
- Annotate each artboard with a short label naming the screen and state (e.g. "Recording —
  interrupted by phone call") so exports are self-describing.

## Deliverable

One canvas: a flow row of phone artboards for screens 1–7 (with key alternate states as adjacent
artboards), one tablet artboard, plus a small "design tokens" artboard (palette, type scale,
status-chip colors, spacing) that a developer can transcribe directly.

---

## Using the output with Codex

Claude Design's canvas is the visual source of truth; Codex consumes it as:

1. **PNG exports** of each artboard, attached to the Codex thread (Codex reads images well —
   screenshots of artboards are more reliable than raw `.dc.html`).
2. **A written companion spec** (screen inventory, state machine per screen, token table) — ask
   Claude to generate this from the finished canvas. Text constraints steer Codex harder than
   pictures do; ship both.
3. The spec plus exports get referenced from Phase 2 of `CODEX_MOBILE_CAPTURE_PROMPT.md`; the
   binding protocol/security behavior stays with the ADRs, never the mockups.
