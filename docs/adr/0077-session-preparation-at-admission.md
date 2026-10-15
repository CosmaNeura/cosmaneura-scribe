# 0077 — Prepare recording metadata in the session admission response

Keep Core authoritative for visit access and consent. Scribe can return its
existing preparation read immediately after the existing configured admission,
using a separate additive endpoint and the same immutable idempotency family.
This removes one Core-to-Scribe HTTP request without changing authority checks,
audio readiness, source proof custody, key binding or stop recovery. Preparation
is not a capture grant. Partial admission success followed by key/read failure
is unpublished and recovered by the original session key, never a new family.

Visit token preparation is native-only, one-use, visit/session/revision scoped,
and bounded by the original five-second clock and JWT expiry. It grants no cached
access decision. All server-side current-access and consent decisions still run.
