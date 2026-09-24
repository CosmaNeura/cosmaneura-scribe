# Retained native provider source

These are the first-party native sources used for the approved desktop/iOS
Scribe builds. The September 24 transport change gives admission time to finish
both shared-Core phases. It does not extend capture authority or retry a mutation.

The existing ClerkKit source remains a locked build dependency. No SDK upgrade is
included. `clerk-source-lock.json` pins all 233 retained dependency files, including
the license and resources. Use `scripts/assemble-native-source.py` with an explicit
local `--clerk-source` directory; it rejects changed/missing/extra files and links,
then copies both repository sources and that dependency into a new output directory.
The original dependency is never edited. There is no implicit SDK download.

Example, from the repository root:

```sh
python3 scripts/assemble-native-source.py /tmp/scribe-native-inputs \
  --clerk-source /path/to/retained/cosmas-native-auth/vendor
python3 scripts/build-desktop-native-provider.py /tmp/scribe-native-helper \
  --native-auth-source /tmp/scribe-native-inputs/cosmas-native-auth
```

Use the same assembled `ios-pcm-capture`, `ios-pcm-capacitor` and
`cosmas-native-auth` sibling packages in the existing approved iOS project.
Build 9 remains the installed iPhone version until a new signed package is installed.
The packages omit dangling test targets from the earlier build-only snapshots;
that change does not claim to import their historical qualification suites.

Repository source and dependency hashes establish build inputs. They do not prove
installed recording, recovery, processing or note acceptance. A fresh clone still
requires the exact retained SDK dependency before an offline native build.
