import type { ConsentPreparationRelease } from "./consent-preparation";

/** Explicit control for the owner's signed beta candidates. This changes when
 * preparation begins; it does not grant consent or recording authority. */
export const BETA_CONSENT_PREPARATION: ConsentPreparationRelease = Object.freeze({
  enabled: true,
  owner: "John Clemente",
  cohort: "internal",
  expires: "2026-11-01",
});
