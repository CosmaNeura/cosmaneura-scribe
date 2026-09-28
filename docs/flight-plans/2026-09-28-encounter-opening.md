# Combined encounter opening

Owner: MCD operational beta owner. Scope: existing standalone provider receiver
and its matched Mac/iPhone clients. Tier 2 because negotiation lifetime is
involved, although identity verification and access checks remain unchanged.

## Outcome

Opening an encounter currently mounts it with three Core requests, then repeats
those three requests before reading its current recording/review state. The
optional combined opening uses one negotiation followed by the existing
`provider_encounter` read: four Core requests instead of seven. This is a request
count reduction, not a measured staging latency or recording-start claim.

## Contract and boundaries

The catalog advertises `opening_review_v1: true`. A capable client may send
`{workspace_id, opening_nonce}` to the existing mount route. The response adds
`openingReview`, the unchanged Core provenance envelope for that nonce. Clients
without support keep sending `{workspace_id}` and receive the legacy response.
No capability token, credentials or new authority fields are exposed.

Negotiated credentials live only within this single HTTP opening request.
Registry identity/selection is checked before and after each Core request, and
again before publication. Core still authorizes the existing encounter read.
Every later operation, including recorder access and recording preparation,
negotiates anew. Cancellation and response-scope failures discard the opening.
This does not start a source, infer consent or modify recording custody.

## Receiver-first rollout

1. Merge the optional receiver contract with local transport and real frozen
   identity/schema integration evidence. Existing clients are unchanged.
2. Add matched client consumption with bounded response handling, validated
   scope/nonce, short-lived one-use display data and fresh later actions.
   Preserve pending-save, pending-admission and device-custody recovery paths.
3. Roll out the merged receiver before the matched clients under the existing
   staging release process. Initial cohort: approved synthetic staging testing.
   The native release is the activation control; it expires when acceptance is
   recorded or the candidate is superseded. Do not replace a signed candidate.
4. Compare the same encounter's opening latency before/after and run saved-work
   and no-journal recovery checks. Physical-device acceptance stays separate
   from simulated network and software checks.

## Recovery and evidence

Before client activation, revert the receiver change through a PR and redeploy
the previous approved artifact. After activation, first restore the prior native
client, then the receiver. A client seeing no catalog capability uses the legacy
opening; transport/access failures are not evidence of absence and must not
silently create a fresh encounter. Preserve all journals, recordings and keys.

No schema, stored transcript format, fixture/live data or environment change is
part of this source PR. Core and Session Prep require no contract change. No
deployment or native installation is claimed by the merge evidence.
