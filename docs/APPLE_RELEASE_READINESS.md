# Apple release readiness

This checklist records build metadata and local verification only. It does not
authorize certificate or profile creation, notarization, App Store Connect
submission, TestFlight upload, or distribution.

## Approved identifiers

- Apple Developer team: `JVV65668U6` (Cosmaneura Inc)
- Capacitor application: `com.cosmaneura.capture`
- Electron application: `com.cosmaneura.desktop-companion`

The Capacitor Xcode project uses automatic signing with the approved team, but
does not persist a provisioning profile. The Electron identifier is an intended
packaging value and is not yet wired by this slice.

## Current gates

All release gates remain false until their evidence exists:

- full supported Xcode and an iOS Simulator runtime installed and selected;
- App ID registered for the intended bundle identifier;
- valid Apple Development or distribution signing identity available;
- matching provisioning profile available;
- unsigned simulator build passes on the supported Xcode toolchain;
- physical-device capture behavior is tested where applicable;
- signed archive validation passes;
- notarization or App Store submission is separately authorized and succeeds.

An Apple Developer membership and a configured Team ID do not satisfy any of
the signing, device-testing, notarization, or distribution gates by themselves.

## Safe local checks

Run from the repository root with the pinned Node and npm versions:

```sh
npm run test:apple-release-metadata --workspace @cosmaneura-scribe/capture
npm run typecheck --workspace @cosmaneura-scribe/capture
npm run lint --workspace @cosmaneura-scribe/capture
DEPLOY_SHA="$(git rev-parse HEAD)" npm run cap:sync:check:ios
xcodebuild -version
xcrun simctl list devices available
security find-identity -v -p codesigning
```

After full Xcode and a simulator runtime are installed, the capture-disabled
simulator rehearsal is:

```sh
xcodebuild \
  -project apps/capture/ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -sdk iphonesimulator \
  -derivedDataPath /private/tmp/cosmaneura-capture-derived-data \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Do not remove `CODE_SIGNING_ALLOWED=NO` or perform an archive until a matching
identity/profile exists and the signing rehearsal is explicitly authorized.

## Human-controlled portal steps

These remain deliberate user actions:

The account holder accepted the current App Store Connect terms on August 26,
2026. If Apple presents a newer agreement, acceptance remains a human action.

1. Register the exact App IDs after reviewing capabilities and entitlements.
2. Create or install only the required certificates and provisioning profiles.
3. Explicitly authorize any signed archive, notarization submission, or
   TestFlight upload.
