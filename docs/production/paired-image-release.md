# Paired image publication and dark promotion

This is a manual source route for the existing operator machine. It builds
nothing and provisions nothing. Agents may inspect and prepare read-only plans;
only the founder may execute an individually approved plan interactively.
Publication and promotion require separate confirmations. Access/configuration,
database/schema, key/grants, networking, production Clerk/native configuration,
cohort and live canary are separate founder decisions.

Use the existing installed `python3`, Docker, `az` and `gh`. Azure and registry
authentication must already be established through the authorized owner route;
the operator reads no 1Password item and runs no login/credential installation.
The gh identity for mutation must be `JohnClem`, as in Core's founder guard.
Use clean checkouts of exact current Core master and Scribe main, with the normal
origin remotes. Current Core must equal the reviewed image source. Scribe may
advance through this tool/docs change only if sealed receiver/bundle inputs stay
identical; original image labels and manifests are never rewritten.

Prepare an independently reviewed `paired-production-artifact-v1` JSON document
with exactly these fields:

- `core_revision`, `core_tree`, `scribe_revision`, `scribe_tree`: original merged
  40-character revisions/trees.
- `archive_sha256`, `archive_bytes`, `image_digest`, `config_digest`: exact bytes
  and SHA-256 bindings, not a local tag or engine ID alone.
- `core_base_digest`, `core_base_layers`: reviewed base digest and the complete
  ordered prefix of base layer digests in the paired image.
- `core_runtime_sha256`: canonical SHA-256 of the image config's `User`, `Env`,
  `Cmd`, `Entrypoint`, `WorkingDir` keys, including null when absent. Canonical
  JSON sorts keys, uses compact separators, and has no trailing newline.
- `independent_evidence_sha256`: SHA-256 of the accepted independent artifact
  qualification evidence; keep that evidence with the owner's decision packet.
- `qualification`: exactly `core_processes_passed`, `child_env_i_uid10001_passed`,
  `disabled_profiles_passed`, `disabled_workers_passed`, `sealed_source_passed`,
  each boolean true. These are retained independent observations, not checks
  invented by the operator or a production-enabled acceptance claim.
- `schema`: `paired-production-artifact-v1`.

Keep the document and archive at canonical absolute paths. The archive must have
the same single-image Docker-save `manifest.json` and OCI index, no RepoTags,
and only digest-addressed regular blobs. Its original local-only label is retained;
the separate verified publication receipt records publication without changing
bytes. Commands below use placeholders; substitute the reviewed canonical paths
and accepted hashes without putting credentials in arguments or chat.

Registry absence is determined only by exact membership in a successful complete
tag list for the existing repository, with no `--top` limit. Malformed, duplicate,
non-string, incomplete or failed output stops; present tags require a successful
exact digest read. CLI3/404/error-message text never substitutes for that proof.
Retain the original failed first plan and select a fresh reviewed command after
the source correction; do not automatically retry it.

```sh
python3 tools/production/paired_image_release.py inspect \
  --archive /absolute/paired-image.tar \
  --review /absolute/paired-image-review.json --review-sha256 REVIEW_FILE_SHA \
  --output /absolute/new-inspection.json
```

`inspect` uses no cloud, daemon or network. It verifies every archived blob and
the source/runtime contract. The metadata includes no credential/config values.
Plan publication next; the explicitly selected **existing** Docker daemon must
be the same one approved for loading and publishing this synthetic-free image.
The unique tag contains both full original source revisions and a digest suffix;
the full remote digest is the actual acceptance and promotion selector.

```sh
python3 tools/production/paired_image_release.py plan-publish \
  --archive /absolute/paired-image.tar \
  --review /absolute/paired-image-review.json --review-sha256 REVIEW_FILE_SHA \
  --core-source /absolute/current-core --scribe-source /absolute/current-scribe \
  --docker-host EXISTING_DOCKER_ENDPOINT --output /absolute/new-publication-plan.json
```

Review the plan and its printed **canonical** SHA-256. This is not the formatted
JSON file's byte hash. Within 30 minutes, the founder may run:

```sh
python3 tools/production/paired_image_release.py execute \
  --archive /absolute/paired-image.tar --plan /absolute/new-publication-plan.json \
  --approved-plan-sha256 CANONICAL_PLAN_SHA \
  --core-source /absolute/current-core --scribe-source /absolute/current-scribe \
  --output /absolute/new-publication-receipt.json
```

At the terminal prompt, type `PUBLISH CANONICAL_PLAN_SHA` exactly. A conflicting
remote tag, changed source, failed command or converted remote manifest stops.
No host is changed. Already-present exact publication is a verified no-op. The
operator uses existing Docker image load/tag/push and Azure image metadata reads;
it starts no container and changes no registry credential or permission.

Execution creates one exclusive plan-hash journal under the fixed owner-private
`~/.cosmaneura-scribe-release-journal` directory. Its start marker and each push
or host-update intent are fsynced before mutation. Acknowledgements and failures
are appended privately. A pending intent without acknowledgement after an
interruption is unconfirmed, even if the remote service eventually finishes.
The same plan is refused again regardless of output path. Keep this journal on
the existing operator machine; do not change machines, remove markers or retry
without founder review of actual remote/host state and a separately approved
reconciliation/new plan. The tool has no automatic resume, retry or rollback.

Commands have fixed deadlines: 60 seconds for reads, five minutes for loading,
and ten minutes for a push or host update. On timeout or founder interruption, only the newly owned
command process group is terminated/killed and reaped with bounded cleanup.
The remote mutation remains unconfirmed; killing a CLI is not remote rollback.
Both publication and promotion require an operator maintenance window excluding
other production writes. Fresh CLI comparisons are not atomic CAS and cannot
guarantee prevention of every concurrent tag/configuration overwrite.

Once the exact remote digest is verified, prepare **another** plan:

```sh
python3 tools/production/paired_image_release.py plan-promote-dark \
  --archive /absolute/paired-image.tar \
  --review /absolute/paired-image-review.json --review-sha256 REVIEW_FILE_SHA \
  --core-source /absolute/current-core --scribe-source /absolute/current-scribe \
  --output /absolute/new-dark-promotion-plan.json
```

This plan reads only `cosmaneura-prod-app`, `cosmaneura-prod-worker`, and
`cosmaneura-prod-scheduler` in the existing production subscription/group.
Environment/secret/configuration values remain in memory and only fingerprints
are retained. Existing bundle flags must be literal false or absent. Confirm the
prior images, `replace_image_only` drift disposition and preserved configuration.
All three hosts must already contain literal `AUTO_MIGRATE_ON_STARTUP=false`
without `secretRef`. Core's default when absent enables startup migrations, so an
absent, true or opaque setting blocks promotion before any image update. The
operator never changes environment or runs migrations; configuration/schema
disposition is a separate owner-approved prerequisite. Publication is unaffected.
Exclude concurrent Core deployment/infrastructure writes during execution; there
is no cross-repository workflow lock or claimed atomic compare-and-swap.

The founder may execute that separately approved plan with the same command and
its new hash, typing `PROMOTE-DARK CANONICAL_PLAN_SHA`. Each write uses only
`az containerapp update --container-name ... --image ...`; commands, Env, identity,
ingress, scale and all other configuration must pass fresh pre/post comparisons.
No bundle flag is enabled. A partial/unconfirmed write stops and identifies the
affected/completed hosts; inspect actual state and choose an independently
reviewed recovery or replan. Do not automatically roll back keys, schemas, data,
grants, configuration or a host changed by other Core work.

An execution receipt reports published bytes or three updated hosts and explicitly
keeps activation/canary false. It cannot qualify production login, storage,
database, key authorization, note quality or capture. Those milestones remain in
the release decision packet until actually accepted.
