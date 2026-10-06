# Final Python formatting qualification

This owner-requested cleanup formats the remaining Python and embedded Python
examples. Transcript-storage paths make the production batch Tier 2, even though
no runtime, SQL, contract, consent, identity or configuration change is intended.
There is no schema change and no migration is applied outside disposable tests.

For every Python file, compare parsed syntax trees with the parent commit,
including all runtime string constants. Two docstrings receive corrected
indentation: the synthetic endpoint guard and Azure source normalization.
Verify `inspect.cleandoc` produces identical text and no runtime code consumes
their raw whitespace. Compare comments too; do not claim every raw docstring
byte is unchanged.

The capture protocol generator emits double-quoted Python literals so its
output agrees with Ruff. Verify the generated protocol has the same parsed
syntax tree as its parent, the generator freshness test passes, and the existing
Python and Node golden vectors still match. Protocol values and wire bytes must
remain unchanged. Any unexplained syntax-tree mismatch blocks qualification.

Run whole-repository Ruff lint, format and Pyright checks. Run the full Python
suite with a fresh, explicitly owned local PostgreSQL database, including its
actual migration and tenant-isolation tests. These are local synthetic results,
not hosted CI, staging acceptance or supported native-device acceptance.

Split the work if it exceeds 2,000 changed lines or 50 files. Each final push
requires independent agent review. Recovery is reverting the relevant source
commit before promotion; there is no deployed state or schema to undo. Actions
remains disabled and this work does not authorize merging or deployment.

## JavaScript test runners

Keep the timing reporter and iPhone performance CLI regressions in the standard
capture test command, but run them with Node's test runner rather than Vitest.
Exclude only these two exact files from Vitest; retain the Vitest-based MJS
distribution tests and the no-tests failure gate. Run both test groups in order
and propagate either failure. This is a separate Tier 1 test-tooling change;
clinical, consent and storage behavior remain unchanged. Qualify whole web lint,
types, workspace tests and a synthetic build with the exact committed source
SHA. Recovery is reverting the test-runner commit before promotion.
