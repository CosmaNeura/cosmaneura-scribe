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

/** Only explicit host timestamps determine date ordering and filters. */
export function encounterTimestamp(detail: string): number | null {
  const suffix = / · (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))$/u.exec(detail)?.[1];
  const stamp = suffix ? Date.parse(suffix) : NaN;
  return Number.isFinite(stamp) ? stamp : null;
}

export function orderedNoteFields(keys: readonly string[]): { clinical: string[]; details: string[] } {
  const details = keys.filter(key => /^(patient(?: name| information| details)?|name|dob|date of birth|date(?: of (?:visit|service))?|visit date|appointment|provider(?: name)?|clinician(?: name)?|encounter(?: type)?|modality|location|language)$/iu.test(key.trim()));
  const clinical = keys.filter(key => !details.includes(key));
  const rank = (key: string): number => /^(?:chief complaint|reason for visit)$/iu.test(key) ? 0
    : /^(?:subjective|hpi|history of present illness)$/iu.test(key) ? 1
    : /^(?:objective|exam|physical exam|examination)$/iu.test(key) ? 2
    : /^assessment$/iu.test(key) ? 3 : /^plan$/iu.test(key) ? 4 : 5;
  clinical.sort((a, b) => rank(a) - rank(b));
  return { clinical, details };
}
