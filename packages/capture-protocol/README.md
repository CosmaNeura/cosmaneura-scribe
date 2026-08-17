# Capture protocol v1

This private package is generated from `protocol/capture_protocol_v1.json`. Do not edit
`src/generated.ts` by hand. Regenerate it with:

```bash
uv run python scripts/generate_capture_protocol.py
```

The package supplies the pinned wire-format implementation and cross-language verification used
before the Capacitor client exists. A future client must use server-issued AAD bytes from chunk
reservations; it must not reconstruct tenant-bound AAD from client-visible identity data.

Run the TypeScript golden vectors with Node 24:

```bash
node packages/capture-protocol/test/golden-vectors.mjs
```
