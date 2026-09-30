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
