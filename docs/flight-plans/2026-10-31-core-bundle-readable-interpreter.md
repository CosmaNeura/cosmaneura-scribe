# Core bundle readable interpreter — Tier 2

The actual local Core dc73 / Scribe 0d3 image built, but child user 10001 could not
execute `/opt/scribe/runtime/bin/python`: UV linked it through
`/root/.nix-profile/bin/python3` and `/root` has mode 0700. The existing Core interpreter
at `/opt/venv/bin/python` is a copied file with mode 0755; its actual Python 3.13.0 default-off
hook check passed as user 10001. Retain that failed image, archive and container-cleanup
receipts as evidence; it is unpublished and nonpromotable.

Use that existing Core interpreter explicitly for the frozen Scribe install and
copy its executable into the isolated Scribe venv, replacing the symlink itself.
Core dependencies, commands, user and paths stay intact; child user 10001 and all dark
flags remain required. No dependency, configuration, credential or grant changes.
This implements the existing ADR 0093 option; it introduces no new architecture.

Review the exact source independently, merge normally, then rebuild from actual
merged Core 716ab350 and the actual Scribe merge commit. Reverify source/lock bytes,
Core Cmd/Entrypoint/Env equality, every archive layer and the actual isolated child
under user 10001 with network disabled/read-only. Its prefix, stdlib and compiled imports,
disabled profiles/workers and in-memory receiver 404 must pass; a root-only build
assertion is insufficient. Retagging the old dc73 image is not a canonical rebuild.
No production publishing, deployment, login, data or activation is authorized.

Before any separately approved deployment, recovery is to discard this local
candidate. After deployment, stop admissions/pickup, drain accepted work, disable
bundle flags and restore the prior qualified compatible image/config pair. Preserve
ciphertext, keys, mappings, schema, audit and idempotency receipts; network/grant
revocation remains a separate owner decision. Existing PG/Clerk/private KV/Blob
network/grant/cohort and production promotion holds remain open.
