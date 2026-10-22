# ADR 0085: retain preparation lineage when a corrected transcript advances

A submitted draft preparation remains bound to its original schema, reviewed
source and client key. After a higher working version is saved, an explicit
**Prepare updated draft** action appends a separately keyed submitted successor
in the existing encrypted workspace journal. The session, raw source, working
transcript ID and capture continuity must stay the same. CAS confirms the append
before dispatch; the original intent and earlier successor prefix are immutable.
The newest successor becomes the selected preparation; at most sixteen are kept.
The limit blocks another append and offers dashboard continuation without
truncating retained records. This is metadata only: no transcript, note body,
consent, authentication or backend schema is changed.

Opening, polling and restart recovery use reads only. A newer-source successor
whose paired fresh review/note reads return `not_prepared` may offer an explicit
**Retry updated draft** action. The click repeats those reads and reuses that
successor's exact existing key, schema and source. It neither appends another
intent nor automatically retries. If a draft already exists it is displayed
without preparation. This handles a crash after journal CAS but before request
dispatch, while warning that an earlier preparation may still finish. Core does
not deduplicate model calls by this key: another model call is possible. Its
current-source publication checks and this client's post-reply source/key checks
remain required. Concurrent source advance may do work in Core, but its reply
cannot be presented under an older selected intent.

Unconfirmed saves and retained unsaved edits block an updated preparation. Keep
preserves the old edit buffer; explicit discard clears only that local buffer.
It never removes a saved note or applies old edits to a replacement. Original
source-bound save-status/resolve behavior is retained. If a pending old save
cannot be reconciled after source advance, the exact save stays retained for
comparison in the dashboard; this client does not clear or rebase it.

Legacy journals with no successor field still load. Build 97's closed reader
rejects the new optional field, so recovery after a successor append requires a
successor-capable client with the same encrypted device metadata. Installing an
older client or resetting its data is not a safe recovery move. No remote data
migration, backfill, automatic preparation replay or eligibility shortcut exists.
