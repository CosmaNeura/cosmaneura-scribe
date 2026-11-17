# Mac App Store public display name

Apple Guideline 5.2.5 rejected a submission whose public app name contained
“Mac”. The Store build’s public display name is **Cosmas Scribe**. The
direct-beta build keeps **Cosmaneura Scribe for Mac** so existing beta installs
are unchanged.

This repository prepares Store inputs; the final signed Store `.app` assembly
still happens out of git. That out-of-git step must set:

| Field | Required value |
| --- | --- |
| Bundle filename | `Cosmas Scribe.app` |
| `CFBundleName` | `Cosmas Scribe` |
| `CFBundleDisplayName` | `Cosmas Scribe` |

Leave unchanged:

- Executable `Contents/MacOS/Cosmaneura Scribe Store`
- `package.json` `productName` `Cosmaneura Scribe Store`
- All bundle IDs (including `com.cosmaneura.scribe.beta.desktop.store`)
- Electron helper app names
- userData folder `Cosmaneura Scribe Store`

## Required pre-upload check (human later; not an agent step)

Install over the previous Store build with an existing synthetic journal, then
confirm the app opens and that the Keychain “Safe Storage” item name is
unchanged.

## App Store Connect

Renaming the app in App Store Connect is a separate human step. Do not change
ASC records from this repository or from an agent run.
