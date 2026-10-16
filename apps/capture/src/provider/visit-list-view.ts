import type { ProviderEncounter } from "./workspace-contracts";
import { encounterTimestamp } from "./workspace-display";

export const escapeText = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function visitDay(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
export function adjacentVisitDay(value: Date, direction: number): Date {
  const next = new Date(value); next.setHours(12, 0, 0, 0); next.setDate(next.getDate() + direction); return next;
}
export function visitIsOnDay(encounter: ProviderEncounter, day: Date, today = new Date()): boolean {
  const stamp = encounterTimestamp(encounter.detail);
  // Older hosts can supply an undated visit. Keep it reachable on Today.
  return stamp === null ? visitDay(day) === visitDay(today) : visitDay(new Date(stamp)) === visitDay(day);
}
export function visitStatus(status: ProviderEncounter["status"]): { label: string; tone: string } {
  switch (status) {
    case "draft_ready": return { label: "Note ready", tone: "ready" };
    case "processing": return { label: "Preparing your visit…", tone: "waiting" };
    case "recording_saved": return { label: "Conversation ready", tone: "ready" };
    case "paused": return { label: "Paused — visit not finished", tone: "paused" };
    default: return { label: "Not started", tone: "quiet" };
  }
}
export function visitRow(encounter: ProviderEncounter, status = encounter.status): string {
  const stamp = encounterTimestamp(encounter.detail), state = visitStatus(status);
  const time = stamp === null ? "" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(stamp);
  const pending = status === "processing";
  const action = status === "draft_ready" ? "open-draft" : "open";
  const label = (status === "draft_ready" || status === "recording_saved") ? "Open note" : status === "paused" ? "Resume" : "Start";
  return `<li data-visit-ref="${escapeText(encounter.appointmentRef)}" data-visit-time="${stamp ?? ""}">
    <time class="provider-visit-time">${escapeText(time)}</time>
    <div class="provider-visit-name"><strong>${escapeText(encounter.identity?.name ?? encounter.patientName ?? encounter.title)}</strong><span class="provider-visit-inline-time">${escapeText(time)}</span>
      <span class="provider-visit-status" data-tone="${state.tone}">${state.tone === "waiting" ? '<i aria-hidden="true"></i>' : ""}${state.label}</span></div>
    ${pending ? '<span class="provider-visit-wait">Preparing…</span>' : `<button class="provider-visit-action${status === "draft_ready" ? " provider-open-note" : " provider-primary"}" data-workspace-action="${action}" data-appointment="${escapeText(encounter.appointmentRef)}">${label}</button>`}
  </li>`;
}

/** Horizontal, intentional gestures only; scrolling, text entry and OS edges win. */
export function bindDaySwipe(root: HTMLElement, change: (direction: number) => void): () => void {
  let start: { x: number; y: number } | null = null;
  const down = (event: TouchEvent): void => {
    if (event.touches.length !== 1 || event.target instanceof Element && event.target.closest("input, textarea, button, a")) { start = null; return; }
    const touch = event.touches[0]!;
    start = touch.clientX > 24 && touch.clientX < window.innerWidth - 24 ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const up = (event: TouchEvent): void => {
    const touch = event.changedTouches[0], origin = start; start = null;
    if (!origin || !touch) return;
    const x = touch.clientX - origin.x, y = touch.clientY - origin.y;
    if (Math.abs(x) >= 72 && Math.abs(x) > Math.abs(y) * 2) change(x < 0 ? 1 : -1);
  };
  root.addEventListener("touchstart", down, { passive: true }); root.addEventListener("touchend", up, { passive: true });
  return () => { root.removeEventListener("touchstart", down); root.removeEventListener("touchend", up); };
}
