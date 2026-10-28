# R12 exact-recording collector contract

This lab-tooling contract corrects the R11 false refusal without changing any
shipping application behavior.

## Live recording predicate

A fresh collector observation is admissible only when:

- Core's exact doctor, account, meeting, appointment, patient, host,
  occurrence, bot digest, and recording digest match the selector's tuple;
- the durable binding has no terminal status;
- Redis has the same bot/host/doctor/occurrence, `recording_active=1`,
  `capture_started=1`, and no `capture_terminal`;
- Recall's bot GET contains exactly one row with the selector-bound raw
  recording ID (other nonmatching historical rows are ignored);
- that exact row is `processing`, has `started_at`, and has no `completed_at`;
- the known Recall bot-status history contains no terminal event; and
- distinct, byte-pinned normal-host artifacts prove `approve_recording` and
  the later visible `recording_active`/REC state.

Recall bot status is deliberately a terminal-negative guard, not positive
recording authority. R11 observed `in_call_not_recording` for more than four
minutes while the exact durable-bound recording existed and later completed.
The exact provider row plus Core DB/Redis authority is the positive predicate.

## Preserved safety properties

- one provider GET per observation, bracketed by Core reads;
- read-only DB transaction and no Redis/provider mutation;
- 1.8-second producer bound inside the existing two-second admission window;
- one-second caller observation cadence;
- loopback-only relay and one in-flight request;
- consent and REC artifact hashes pinned across the session;
- no automatic retry/reselection after a refusal; and
- the separate bounded stop lane still requires terminal provider state,
  normal host End, and one exact completed canonical release.

## Focused checks

```text
node --test tools/virtual-lab/zoom/bot-capture-proof.test.mjs
node --test tools/virtual-lab/coordinator/live-bot-collector.test.mjs
node --test tools/virtual-lab/coordinator/bot-observation-relay.test.mjs
python3 tools/virtual-lab/coordinator/live-bot-reader.test.py
python3 -m py_compile tools/virtual-lab/coordinator/live-bot-reader.py tools/virtual-lab/coordinator/live-bot-private-transport.py tools/virtual-lab/coordinator/live-bot-bound-cli.py
```

These are synthetic/offline checks. The relay test binds only `127.0.0.1`.
They do not qualify a live meeting or authorize a deployment.
