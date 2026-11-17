# AGENTS.md — Cosmaneura Scribe (one page)

Hard rules for agents. Longer process text lives in
`docs/reference/archive/agent-rules/`. CosmaBot (`cosmaneura-os`) is a different
product — do not copy its freer production authority here.

## Hard rules

1. **Staging is the default** for agent builds and tests. Use staging Cosmas
   (`staging-app.cosmaneura.com`) and staging Clerk (`resolved-emu-53`).
2. **Production package or deploy needs John’s yes.** No production assemble,
   unlock, promote, or live credential use without it.
3. **Synthetic data only.** No patient data, PHI, secrets, or live credentials
   in tests, fixtures, logs, PRs, or chat.
4. **Small PRs.** One reviewable outcome each; stay inside the change-budget
   gate. Declare a risk tier on every PR. Never force-push `main`.
5. **Red checks stay red.** Do not wave away failing machine checks with local
   notes, status fabrication, or workflow reruns. GitHub Actions stay on
   permanently (John’s standing order, 5 Nov 2026)—do not disable them or tell
   anyone to disable them.
6. **Independent review after the last substantive push.** Agent output is not
   GitHub approval and does not replace John’s production yes.

## Agents may do alone

- Branch, code, synthetic tests, draft/open PRs, fix CI on that PR.
- Use **staging** hosts, profiles, and keys only.
- Read-only inspection of docs and non-secret config.
- Run the relevant tests inside the cloud agent before pushing.
- Push once per round (no empty commits; one substantive push after local proof).
- Get a green CI and CodeQL run on the head before asking for Fable review.

## Needs John’s yes

- Production package, unlock, deploy, or promote.
- Live login / Clerk / auth-boundary changes aimed at production.
- Real patient data, destructive data work, migrations that remove data.
- Turning off or weakening safety checks, Trivy, CI workflows, or required
  ruleset contexts (Actions stay on; never propose flipping them off).
- New paid services, production credentials, or App Store / production Azure
  changes.

## Never

- Merge to `main` yourself, force-push `main`, or deploy an unmerged branch.
- Disable GitHub Actions, or advise anyone to disable them.
- Put secrets or PHI in the repo or in chat.
- Touch CosmaBot production authority as if it applied to Scribe.
- Edit someone else’s `codex/*` branches.

Commands, tiers, flight plans, and deploy-kit detail:
`docs/reference/archive/agent-rules/AGENTS-v0.2.1.md`. API domain rules:
`CLAUDE.md`.
