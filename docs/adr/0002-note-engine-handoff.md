# ADR 0002: Adapt to the existing transcript model

**Status:** Accepted

The scribe keeps a richer internal transcript with speaker IDs, roles, channels, confidence, and
timestamps. At handoff it maps clinician/patient roles to the current `Doctor`/`Patient` speaker
labels and camel-cased millisecond timestamps. Note styling remains outside this repository.

