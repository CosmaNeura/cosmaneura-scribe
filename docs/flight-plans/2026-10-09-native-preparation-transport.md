# Native preparation setup, Core receiver first

Tier2. Replace repeated Core network lookup/exchange/mount setup with one
server-only setup call for configured fresh admission and first recording window.
The setup call performs no capture mutation. Keep a distinct fresh native account
check after setup and directly before the ordinary mutation, plus post-response
and publication fences. Original body/key, lease/consent/session recovery and
legacy/resume/physical source paths remain unchanged. No automatic fallback or
retry. Credentials from setup are consumed only within this invocation and never
returned to a device. Core retains every original current policy decision.

Deploy the Core receiver first, then this sender. Recover sender first, then Core.
Retain prior immutable images. No identity, grants, policy, cohort, configuration,
schema, dependencies, billing or production change. Virtual audio only. Record
exact source/test/review and current schema/config/recovery facts. Goal remains
5–7s; latest installed Core714 spans are17.562 and10.309s, both Ready/0:00.
