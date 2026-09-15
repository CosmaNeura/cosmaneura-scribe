<!-- deploy-kit v0.2.1 -->

## Outcome and scope

<!-- State one deployable outcome and the explicit non-goals. -->

## Risk class

- [ ] **Tier 0 — routine:** no deployment-surface, schema/data, auth/session,
      billing, PHI, security-boundary, or external-contract impact
- [ ] **Tier 1 — deployment-sensitive/reversible:** deployment or release
      behavior changes but has a deliberate recovery move
- [ ] **Tier 2 — irreversible/high blast radius:** data destruction/scale,
      auth, billing, PHI, security, production identity/network/promotion,
      breaking contract, or broad infrastructure impact

Classification reason:

## Evidence required for every code change

- [ ] Required exact-head status evidence is green for the final substantive
      push. While Actions is disabled, identify locally executed versus
      byte-identical reused evidence; do not describe either as hosted CI.
- [ ] Independent non-implementer agent review identifies the final reviewed
      commit: <!-- link to durable check/comment -->
- [ ] Agent findings are resolved or explicitly accepted in the PR
- [ ] Existing GitHub approval requirements are satisfied in GitHub

Agent evidence is not a GitHub approval. Do not write a person's name here as
proof of review.

- [ ] This PR is one independently deployable outcome; if not, link the
      dependency-ordered split/stack decision

## Conditional controls

<!-- Check only what applies; mark the rest N/A with a reason. -->

- **User-visible reversible behavior:** feature-flag/release-control name,
  owner, expiry, and first cohort; otherwise N/A
- **Flight plan:** link when Tier 2, schema/data, cross-repo, multi-deploy, or
  cohort rollout; otherwise N/A
- **Schema/data:** one rung label, PHI-safe rehearsal evidence, and
  rung-specific recovery; otherwise N/A
- **Cross-repo:** contract version and receiver-before-sender order; otherwise
  N/A
- **Security acceptance:** record link and allowed environment/data boundary;
  otherwise N/A

## Deployment and recovery

- Deployment/runtime effect:
- Current deployed-state comparison required: yes/no; evidence or reason:
- Health/canary signal:
- Exact rollback or recovery move:
- Previous known-good artifact/data boundary:

Scribe has no production promotion workflow today. Any future production
promotion happens only after merge through a founder-only manual workflow.
That run is self-authorization, not a pre-merge checkbox or independent review.

## Change record

- Systems and data affected:
- PHI impact: none / read / write / schema-data
- Tests and rehearsal actually run:
- Documentation or runbook changed:
