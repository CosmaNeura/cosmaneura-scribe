# Capacitor Secure Queue

`@cosmaneura-scribe/capacitor-secure-queue` is the native at-rest store for opaque capture queue
records. It is compatible with, and pinned to, Capacitor `8.5.0`. It is not a general-purpose
secret API and has no browser implementation.

## Bridge contract

- `put({ key, data })` atomically creates or unconditionally replaces one record and returns its
  opaque native revision.
- `create({ key, data })` atomically creates a record, or rejects with
  `SECURE_QUEUE_ALREADY_EXISTS`.
- `get({ key })` returns that record and its revision, or rejects with `SECURE_QUEUE_NOT_FOUND`.
- `list()` returns sorted opaque record keys. Record bytes are fetched separately with `get`.
- `compareAndSwap({ key, expectedRevision, data })` atomically replaces the record only when its
  native revision matches, or rejects with `SECURE_QUEUE_REVISION_CONFLICT`.
- `delete({ key })` returns whether a record existed.
- `clear()` deletes all committed records and returns the number removed.

`data` is strict, padded standard Base64. The plugin treats the decoded bytes as opaque. Keys are
non-empty UTF-8 strings of at most 512 bytes. Callers must keep patient display values, transcript
text, credentials, SAS URLs, raw session DEKs, and other prohibited values out of both fields.

The storage key is created and consumed only by native code; JavaScript cannot supply, read, or
export it. Record filenames are SHA-256 digests of opaque keys, and the original key is inside the
authenticated ciphertext. All bridge errors have fixed messages and codes; native exception text,
keys, and record bytes are never logged or returned in errors.

Revisions are canonical positive decimal strings owned by native code. Callers treat them as opaque
compare-and-swap tokens and must not parse or increment them in JavaScript. Native serialization
plus `create`/`compareAndSwap` prevents competing drain loops from losing state transitions.

## Native custody

- iOS generates a 256-bit AES key with `SecRandomCopyBytes`, keeps it in Keychain with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, encrypts records with CryptoKit AES-GCM, and
  stores atomic files below a backup-excluded Application Support directory using complete-until-
  first-authentication file protection.
- Android generates a non-exportable 256-bit AES-GCM key in `AndroidKeyStore`, stores records below
  `Context.getNoBackupFilesDir()`, and commits each record with `AtomicFile`.

Both platforms bind each ciphertext to its hashed filename as AES-GCM additional authenticated
data. A failed replacement leaves the previous complete record in place. `clear` is a serialized
record-by-record purge; storage APIs cannot promise physical overwrite on flash media.

This key protects queue records only. Session DEK generation, wrapping, active WebCrypto custody,
audio recording, protocol-envelope encryption, and upload behavior are intentionally out of scope.

## App integration

The repository root already treats `apps/capture/native-plugins/*` as npm workspaces. The capture
app must declare this exact dependency:

```json
"@cosmaneura-scribe/capacitor-secure-queue": "0.1.0"
```

After `npm install`, ordinary `npx cap sync ios` and `npx cap sync android` discover and register the
native plugin named `SecureQueue`; no manual registration or plugin configuration is required.

## Verification

`npm test --workspace @cosmaneura-scribe/capacitor-secure-queue` runs dependency-free structural
security checks. Native CI must additionally run:

- Node 24.x and npm 11.5.2: `npm ci`, plugin `test`/`typecheck`, capture-app build, then the repository
  clean-sync assertion;
- Xcode 26.x with an iOS 26 simulator runtime: run the `SecureQueueHostedTests` scheme on a concrete
  available iPhone simulator, then build the generated
  production `App` scheme for `iphonesimulator` with signing disabled;
- JDK 21, Gradle 8.14.3, Android Gradle Plugin 8.13.0, and Android SDK 36: from
  `apps/capture/android`, run
  `./gradlew :cosmaneura-scribe-capacitor-secure-queue:testDebugUnitTest :app:assembleDebug`;
- CI also runs an API 36 emulator with
  `./gradlew :cosmaneura-scribe-capacitor-secure-queue:connectedDebugAndroidTest` to exercise the
  real AndroidKeyStore, no-backup directory, tamper rejection, and compare-and-swap behavior.

The generated app remains installable back to the declared iOS 15 and Android API 24 deployment
floors; those floors still require separate device-compatibility builds before release.

The Android instrumentation test uses a unique test-only Keystore alias and no-backup directory.
The iOS integration test runs inside a minimal, simulator-only, archive-excluded host with its own
bundle ID and default Keychain group. Each case uses a unique Keychain service and temporary
backup-excluded directory. The host is not linked to the production app or included in the Swift
package product. Neither suite uses production records or identifiers. Simulator CI does not
replace physical-device and distribution-signing acceptance before release.
