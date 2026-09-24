# Configured worker release composition

Prepared follow-up only; the reviewed source-start stack and original checkouts remain unchanged. Tier 2: durable processing, encryption, and PostgreSQL roles.

Connect separately identified Speech and translation workers to the configured capture repositories and durable jobs. One explicit tenant, default-off enable gates, managed-identity-only credential selection, no public worker route. Speech retains durable lease/heartbeat/max-three attempts; translation never repeats a provider_call_started job. Creator approval and note readiness stay in the existing review service.

Add only the required role grants after the existing reset/bootstrap. Dedicate the existing separate Speech and translation roles to configured capture; preserve API separation and enforce one-tenant restrictive policies. Disabling bootstrap removes added grants; retained restrictive policies stay closed. No shared database, Azure, installed client, original Core/W13, or protected service_auth/capture-authority edits.

Validation is one new local connection check across the new role boundaries and actual translation runner, with invented results and keys. No live Speech, translation, audio, or device trials. Verify focused type/lint checks. Adoption, identity bindings, job scheduling and deployment remain separate, unapplied decisions.
