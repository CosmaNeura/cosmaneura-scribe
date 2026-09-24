# Local server images and staging authentication gap

The adopted Scribe API/worker and native receiver now have real **Linux amd64** Docker images. Both use the cached base images pinned by digest. The existing declared Python dependencies were downloaded inside local build containers after an offline attempt found a missing cached wheel. The source lockfile and adopted source files were unchanged.

| Image | Local image ID |
| --- | --- |
| API and configured workers | `sha256:0e02b381ca957e7876de2a2039cc04d9a4b35d6010c9e3a52cac558285159d20` |
| Native receiver | `sha256:3b28fcd9d047e461bc800d1cbed7d1adcb7b238e44dff49d5fbe16ea26ba9828` |

The images were checked using their actual packaged startup commands as user `10001:10001` in temporary containers with read-only filesystems, no network, no exposed host ports, no host credential mounts and no added capabilities. The API served its OpenAPI contract including the native source-start route, completed its shutdown lifecycle, and its worker executable rejected disabled execution. The receiver started with its packaged disabled profile, returned the expected unavailable response, and stopped. Uvicorn's normal post-shutdown SIGTERM exit is recorded explicitly.

The two images are saved in a local archive, with its SHA-256 and image IDs recorded in the [image release receipt](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/adoption/image-build/local-image-release.json). This is local image/runtime evidence; no images were pushed or deployed, no provider/audio/device trial was repeated, and staging or installed acceptance has not been established. The shared Core image remains a separate unfinished build using its existing Nixpacks workflow.

## Confirmed staging configuration gap

Read-only Azure management metadata refreshed on September 22 confirms that `cosmaneura-staging-postgres` is PostgreSQL 16, Ready, with password authentication enabled and **Entra authentication disabled**. Its public network access setting is enabled. No cloud configuration or database state was changed by this inspection.

The receiver and configured workers require managed identity for PostgreSQL. The runtime database host is still unbound. If this selected server hosts their state, its Entra authentication and dedicated database principals must be configured through a reviewed change before those clients can connect. The existing Core application's password authentication remains unchanged. The pending administrator-credential lookup is a read-only account inspection, not a runtime credential or authentication fallback.

The prepared P5 lookup and its hashes were rechecked, and the existing local psycopg runtime is available. The separate approval request for `Staging / Azure staging Postgres Database` → `python-connection-string` remains pending. It has not been executed. All activation switches remain off; account/provider/tenant mapping, upload origin, workload bindings, ingress isolation and installed workflow qualification remain unfinished.
