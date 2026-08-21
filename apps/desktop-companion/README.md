# Desktop companion

Electron macOS/Windows capture companion prioritized by central architecture ADR 0018. Its first
adapter runs the pinned Recall Desktop SDK directly in the main process for online, audio-only mixed capture on the
explicitly accepted Zoom Desktop and Google Meet profiles. It keeps an always-visible recording
indicator and remains disabled until the desktop acceptance matrix passes.

Native separate microphone/system channels remain the destination adapter under ADR 0018's exit
criteria; the mixed-audio pilot must not claim dual-channel or offline guarantees. A later
Tauri/native shell remains an option when the native adapter is built, not a prerequisite for the
accelerated pilot.

The Electron renderer must be packaged local-only, sandboxed, context-isolated, and without Node,
remote-module, webview, or generic IPC access. The main process validates IPC channel, schema,
sender frame, and packaged origin; navigation, windows, permissions, protocols, and external links
default to denied. Release builds require hardened fuses, ASAR integrity where supported, signed
provenance, security-update discipline, rollback proof, and downgrade resistance.
