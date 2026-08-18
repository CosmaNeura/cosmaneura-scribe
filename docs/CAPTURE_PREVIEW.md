# Capture preview and test distribution

The preview pipeline builds the PWA and a debug Android APK for every pull request. It is
synthetic-only: it does not activate clinical capture, connect to Scribe, accept patient data, or
carry production credentials. The existing false-default application and infrastructure gates
remain false.

## Current fail-closed status

PWA and APK build artifacts are always produced and retained by GitHub Actions for 14 days. Firebase
App Distribution and Azure Static Web Apps deployment skip successfully when their explicit enable
variables or reviewed credentials are absent.

Azure deployment has an additional hard gate. It remains skipped until the Azure Static Web App is
linked to a separately reviewed deployment of the shared synthetic mock handler and
`CAPTURE_PREVIEW_SHARED_MOCK_READY` is explicitly set to `true`. The backend must reuse the shared
mock contract; it must not duplicate route semantics. Until that work is present and proven, the
repository does not claim a navigable end-to-end HTTPS preview.

The mock backend must keep its synthetic workflow state outside an Azure Functions process. The
state must survive function cold starts, horizontal scale, browser navigation, and an expected
browser/app relaunch for the same preview session. It must be isolated by pull request, bounded in
size, expire automatically when the preview closes, and reject non-synthetic input. An in-memory
module singleton or mutable service-worker state does not meet this requirement.

## PWA cache boundary

`vite-plugin-pwa` is pinned and generates an exact-origin service worker. It precaches only emitted
static HTML, JavaScript, CSS, images, fonts, and the web manifest. There are no runtime cache rules.
The build fails if the precache manifest contains an absolute URL, query string, fragment,
`/api/**`, or `/mock-upload/**`. Navigation fallback also excludes those network paths.

Consequently, API responses, upload capabilities, encrypted envelopes, queue records, IndexedDB
contents, tokens, identifiers, and transcript data are never service-worker cache entries. The
JavaScript implementation of the encrypted queue is part of the signed static application bundle;
the queue's mutable records are not.

Local verification uses the pinned `mise.toml` toolchain:

```sh
mise install
mise exec -- npm ci
mise exec -- npm run lint
mise exec -- npm run typecheck
mise exec -- npm test
mise exec -- npm run build
```

## GitHub environment and Azure asks

Create a protected GitHub environment named `capture-preview`, restricted to this repository's
maintainer-reviewed branches. Configure:

- Environment variable `CAPTURE_PREVIEW_SWA_ENABLED=true` only after the non-production Static Web
  App is approved.
- Environment variable `CAPTURE_PREVIEW_SHARED_MOCK_READY=true` only after the shared mock adapter
  and persistent-state acceptance tests pass.
- Environment secret `CAPTURE_PREVIEW_SWA_DEPLOYMENT_TOKEN`, containing the deployment token for one
  dedicated non-production Azure Static Web App. It must not be a production Static Web App token.

The Azure resource must provide pull-request preview environments over HTTPS and an exact-origin
`/api` route for the shared synthetic mock. Its state store must be synthetic-only and use managed
identity rather than a credential embedded in the client or repository. Apply automatic TTL/reset
per pull request and deny public administrative access. The preview environment must contain no
production BFF, Scribe, Storage, Speech, Key Vault, or patient-data connection.

The workflow never gives the deployment token to build or test steps, and the token-bearing Azure
action receives only the already-built static directory; the token-bearing job does not check out
pull-request source. It does not build or deploy API source.
Deploy the linked mock backend through its own reviewed, identity-federated workflow before setting
the readiness variable. Fork pull requests receive build artifacts but cannot deploy. Closing a
pull request closes its Static Web Apps preview when the deployment token and enable variable are
present.

## Firebase App Distribution asks

Use a dedicated non-production Firebase project and register the Android application ID
`com.cosmaneura.capture`. Create an approved tester group containing only synthetic-preview users.
Then create:

1. A Google Cloud service account dedicated to APK distribution with
   `roles/firebaseappdistro.admin` on only that Firebase project.
2. A Workload Identity Pool provider for GitHub Actions. Restrict its attribute condition to
   repository `CosmaNeura/cosmaneura-scribe`, pull-request workflows, and the protected
   `capture-preview` environment.
3. A `roles/iam.workloadIdentityUser` binding from that restricted provider principal to the
   distribution service account.

Configure these environment variables; none contains a private credential:

- `CAPTURE_PREVIEW_FIREBASE_ENABLED=true`
- `CAPTURE_PREVIEW_FIREBASE_ANDROID_APP_ID` (the Firebase Android app ID, not a client secret)
- `CAPTURE_PREVIEW_FIREBASE_PROJECT_ID`
- `CAPTURE_PREVIEW_FIREBASE_TESTER_GROUP`
- `CAPTURE_PREVIEW_GCP_SERVICE_ACCOUNT` (service-account email)
- `CAPTURE_PREVIEW_GCP_WORKLOAD_IDENTITY_PROVIDER` (full provider resource name)

GitHub exchanges its short-lived OIDC identity at runtime. Do not add a Firebase token or service
account JSON secret. A bounded, dependency-free Node script calls only the official Firebase App
Distribution REST origin; it validates every returned resource name, never prints the access token
or release URLs, and receives a fifteen-minute access token only for the distribution step. The
distributed file is the CI-built debug APK, never a production-signed release, and its release
notes contain only the pull-request number.

The Firebase job checks out that distribution script from the pull request's reviewed base commit,
not from the pull request head, before requesting its short-lived token. Enable distribution only
after this workflow and script have merged to the protected base branch. Pull-request code supplies
the already-built APK artifact but cannot replace the credential-handling script.

The current Gradle debug build uses the runner's ephemeral debug keystore. It supports a fresh
synthetic installation, but a later runner's APK is not a trusted in-place update of an earlier
one; testers must uninstall the earlier preview first. Stable update testing requires a separately
approved non-production signing key, protected signing job, and version-code policy. Those are not
part of this workflow, and no production signing material may be substituted.
