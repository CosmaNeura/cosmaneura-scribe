# Native opening recovery

Risk: Tier 2 because this crosses a consent-adjacent service boundary. Admission
and recording authorization remain unchanged.

An interrupted consent admission can remain `consent_unconfirmed`. Its opening
review correctly refuses a ready receipt, but the composed native mount currently
fails too. The native receiver must accept a separately authorized mount carrying
the same closed recovery disposition already understood by mobile and Desktop.

1. Merge and deploy this receiver change first. It accepts old Core review
   responses and exactly one scoped review or recovery result.
2. Merge and deploy the Core native-mount change. Only `AdmissionUnconfirmed`
   during opening prefetch produces `provider_operation_conflict`; final current
   encounter authorization still precedes publication.
3. Reopen the interrupted synthetic visit. A device retaining its original
   journal must offer explicit preparation recovery. A device without that
   journal must offer the existing separate-visit recovery screen. Opening must
   invoke no consent/session/source mutation.
4. Complete ordinary capture, Save, reopen and playback with a ready admission.
   Source tests alone do not satisfy this live gate.

If qualification fails, retain the uncertain original journal and stop the
rollout. Restore the prior Core image before restoring the prior receiver image.
No database repair, consent fabrication or automatic admission replay is allowed.
