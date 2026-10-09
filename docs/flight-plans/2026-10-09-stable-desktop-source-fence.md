# Desktop recording custody across a Mac restart

Tier 2: native recording custody. The owner resumed the desktop/mobile recording-start goal after reboot. This change repairs the persisted desktop lock identity; it creates no new credential namespace, recording permission, source-start API, or consent exception.

## Evidence and change

The exact protected native journal was readable after restart with zero pending owners. Its two saved inode numbers still matched the two fixed private lock files, but the saved `st_dev` was 16777234 and the current mount reported 16777232. Strict comparison rejected every provider request before network access.

Persist the filesystem volume UUID read from each already-open file descriptor alongside the existing inode numbers. Across restart, accept the same stable volume and files under both exclusive process locks, and durably refresh their mount numbers. Runtime path, device, inode, owner, mode, hard-link and epoch checks stay enforced. The source-fence IPC ticket remains unchanged.

An original journal has no volume UUID. Its one-time upgrade requires unchanged inode numbers, the same fixed private paths, both exclusive locks, a fresh protected journal read and no unresolved owners. A legacy remount with pending owners remains closed. Legacy recovery on the same mount confirms authenticated stop receipts before upgrading. No owner is dropped to repair a disk identity. An ambiguous write poisons custody until a fresh exclusive read.

## Validation and release

Run actual-source generated-file/journal checks, including remount acceptance, stable volume mismatch, replacement inode, active capture lock, stale epoch, missing anchor with a previous epoch, symlink, permissions, pending owner preservation and storage failure. Compile the mirrored source for Mac and iPhone and run native recording tests with generated PCM only. No physical microphone, live visit or patient data is used.

Record the final tested commit, implementer review and local change budget in the PR. Merge under the owner's existing local-validation authority. Build the desktop helper offline using retained pinned SDK files; preserve its signing identity, provisioning profile, entitlements and provider configuration. Install with the previous desktop app retained for recovery. Recheck fictional encounter loading and consent-to-ready timings against the qualified staging backend before claiming the five-second goal.

## Recovery

Restore the retained prior desktop application if the candidate fails acceptance. Keep the protected journal and private lock files. The additive volume UUID is ignored by the prior decoder; current mount numbers allow immediate same-boot recovery. The old binary still has its known restart defect. Never delete recovery state or alter home-directory permissions as rollback.
