# Scribe visual identity

The owner selected the microphone concept on September 28, 2026: a champagne-gold
microphone over a diagonal teal (`#146F6C`) to navy (`#17273C`) gradient. This
distinguishes Scribe from the other Cosmaneura applications.

The original vector is `apps/capture/public/icon.svg`. Its metallic stops are
`#E6CA88`, `#FFF2CA`, `#EBD59C` and `#F8E9B8`. The application header and primary
actions reuse the same background pair. Clinical text remains on a plain light
surface; recording controls retain their established state and warning colors.

The iOS app-icon catalog contains the opaque 1024-pixel PNG of that artwork.
iOS supplies its system corner mask. The desktop `Scribe.icns` uses the same
artwork inside an 840-pixel rounded square on a transparent 1024-pixel canvas,
with 92-pixel margins and a 188-pixel corner radius. Standard 16–1024-pixel
representations were rendered with the existing Sharp runtime and assembled
with Apple's `iconutil`; no new runtime dependency is required.

The desktop host builder includes `Scribe.icns` in its hashed artifact manifest.
Native packaging must copy it to `Contents/Resources/Scribe.icns` and set the
root application's `CFBundleIconFile` to `Scribe.icns` before signing. Preserve
bundle identifiers, authentication settings, entitlements and data containers.
An icon update is an ordinary same-identity application update, never an
uninstall or data reset.
