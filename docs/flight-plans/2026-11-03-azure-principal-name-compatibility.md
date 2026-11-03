# Azure principal-list name compatibility

Tier 2. Production's read-only PostgreSQL catalog reports
`pgaadauth_list_principals(false)` with a `rolname` result column. The existing
bootstrap requires `rolename`, so its role lookup would fail before creation.

Read the name through the row's JSON representation, accepting `rolname` and
the prior `rolename` spelling. Keep the bound role name, object-ID mismatch
refusal, existing privilege/membership checks, and principal-creation call
unchanged. The catalog reports seven identity arguments but does not report
defaults; this change makes no claim about five-argument invocation readiness.

Focused asynchronous mock checks cover both observed name shapes and reject a
different Entra object without creating a role. They are source checks, not
execution of Azure's helpers or acceptance of effective database rights.

Merge and packaging do not execute bootstrap. A production setup must use a
separately reviewed, owner-approved missing-only operation with fresh guards,
the original owner, and preserved Azure public-schema ACLs. Keep source312 and
the running dark image22 as historical evidence; supply corrected source only
under that exact future operation's approval. No owner transfer is included.

Recovery leaves the change dormant and stops an uncertain setup operation
without replay. Reverting this query would restore the known incompatibility;
it does not undo created principals, schema, or grants.
