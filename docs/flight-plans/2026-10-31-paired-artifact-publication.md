# Paired Core/Scribe artifact publication — Tier 2

Implement a manual source operator for an already-built, independently reviewed
Linux/amd64 paired image. Use the existing operator's Docker, Azure CLI and gh
tools, existing production Core registry and the three existing Core hosts.
Do not add a runner, service, workflow, credential or Azure resource. The normal
Core production workflow continues to build Core-only and must not substitute
for this route. This change executes no publication or promotion.

The accepted review document binds the archive hash/size, image manifest/config
digests, both actual merged source revisions/trees, preserved Core layers and
runtime contract, and the independently observed disabled child checks. The
operator verifies every archive blob and exact source labels. The original
Scribe revision stays original when tooling is merged later: current main must
descend from it without changing receiver/bundle inputs. Core must be the exact
current master; new Core work requires a new paired artifact.

Separate plans cover publication and image-only dark promotion. Publication
loads the verified archive into the explicitly reviewed existing Docker daemon,
uses a full-source/digest-specific tag in the existing Core repository, refuses
a conflicting tag, and verifies the exact remote manifest digest after push.
It does not assert that Docker always preserves manifest serialization. A
mismatch stops and leaves production hosts untouched. Repeating publication of
the same already-present exact digest is a verified no-op.

Promotion rereads the exact three existing resources. Its safe plan retains only
configuration fingerprints and prior images, never environment/secret values.
All bundle enable flags must already be absent or false. The only allowed write
is the named existing container's image. Fresh preflight and immediate postflight
compare commands, environment, identity, ingress, scaling and all other resource
configuration. Azure CLI does not provide a proven atomic compare-and-swap:
external deployments must be excluded by the founder's maintenance window;
detected drift or a partial failure stops for founder review, with no automatic
rollback. A three-host update is not atomic.

Mutation requires the authenticated founder, interactive exact plan-hash
confirmation, unexpired plan, unchanged merged source and fresh resource reads.
Every execution has an exclusive fsynced plan-hash journal at a fixed private
owner directory, with durable intent before push/each host update. Interruption
or timeout leaves pending/unconfirmed state and blocks same-plan replay pending
founder reconciliation. Command deadlines terminate/reap only their owned group;
they do not imply remote cancellation. No automatic retry is provided.
The confirmation records self-authorization, not independent approval. Agents
must never invoke mutation modes. Access/credential changes, database/schema,
identity grants, network routes, production native/Clerk configuration, cohort
activation and live canary remain separate explicit founder decisions. Image
publication/dark promotion is not operational-production acceptance.

Focused offline tests cover hostile archive input, false provenance, conflicting
remote image, stale source/plan, founder gate, active flags, configuration drift,
command/Env preservation and partial failure. Review the final source independently
before merge. Discard/revert source before use; after a separately approved dark
promotion, restore only a founder-reviewed compatible prior image/configuration
pair after stopping admission and draining work. Preserve keys, schemas, audit,
ciphertext and grants; never silently undo access or data changes.
