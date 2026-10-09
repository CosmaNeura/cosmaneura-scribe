# 0066 — Renew one native recording owner

Status: accepted for dormant local implementation, 2026-09-27.

The native CosmaBot recorder needs a short-lived continuation capability after
Core renews its capture lease and reserves the next chunk window. Reusing the
initial start capability would either expire a working recording or change the
proof that must remain available to stop it.

Add a separate source-extension receiver. It validates the same creator,
consent, original owner proof, current lease receipt, generation and reservation
batch under the existing consent/session locks. An append-only database chain
binds each extension to its predecessor and exact contiguous chunk range.
An extension cannot start a second recorder or replace the original stop owner.
The same fixed receipt is returned on valid retries; its 15-second expiry is
never refreshed. Expired, stopped, revoked or mismatched requests fail closed.

The receiver follows current Scribe limits (2,048 positions, 90 per batch).
CosmaBot/Core may impose a smaller client limit; this change does not reduce
Scribe's existing capacity. No transcript text or raw owner proof is stored in
the new table. Runtime roles receive SELECT/INSERT only; workers receive no
new access. Existing source-start behavior is unchanged by the repository
factory's default, which can now select the extension subclass.

A tenant-scoped lease-state read returns the committed current receipt and
closed state without creating or renewing a lease. It uses the existing
capture-protocol authentication, consent and mode checks.

Activation is separate: `configured_capture_continuation_enabled` defaults off,
requires configured capture, and uses the same explicit tenant cohort. Owner:
Scribe; initial cohort: none; review date: 2026-09-30. An approved deployment
must reconcile current Scribe artifacts before activation. See the
[flight plan](../flight-plans/2026-09-27-native-capture-continuation.md).
