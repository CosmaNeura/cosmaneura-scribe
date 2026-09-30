/** Format only the explicit ISO timestamp suffix supplied by the encounter host. */
export function encounterDetail(detail: string, locale?: string, timeZone?: string): string {
  const match = /^(.* · )(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))$/u.exec(detail);
  if (!match) return detail;
  const date = new Date(match[2]!);
  if (!Number.isFinite(date.getTime())) return detail;
  try {
    const formatted = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) }).format(date);
    return `${match[1]}${formatted}`;
  } catch { return detail; }
}

/** Neutral display names for legacy template prompts that assert visit facts.
 * Original keys remain unchanged for note validation, editing and persistence. */
export function noteFieldLabel(key: string): string {
  if (/^Exam deferred to in-person visit(?: \d{2}\/\d{2}\/\d{4})?$/u.test(key)) return "Deferred examination";
  if (/^Labs - fasting, \d{2}\/\d{2}\/\d{4}$/u.test(key)) return "Laboratory tests";
  switch (key) {
    case "Observed and patient-assisted exam via video": return "Video examination";
    case "Return precautions - given verbally, repeated back accurately, sent in writing": return "Return precautions";
    default: return key;
  }
}
