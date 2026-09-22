"""Single-purpose native TLS receiver reusing the frozen OS identity/catalog code."""

from __future__ import annotations

import hashlib
import json
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "runtime.json").read_text())
for relative, digest in CONFIG["source_sha256"].items():
    if (
        hashlib.sha256((ROOT / "server-source/cosmas_os" / relative).read_bytes()).hexdigest()
        != digest
    ):
        raise RuntimeError("Frozen receiver changed")
sys.path.insert(0, str(ROOT / "server-source"))

from cosmas_os.api.auth import (  # noqa: E402
    AccessDenied,
    AuthenticationFailed,
    ClerkTokenVerifier,
    authenticate_request,
)
from cosmas_os.application.workspace import WorkspaceError, catalog  # noqa: E402
from cosmas_os.config import Settings  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

settings = Settings(
    _env_file=None,
    auth_mode="clerk_jwt",
    synth_seed=False,
    workspace_enabled=True,
    workspace_authenticated_enabled=True,
    workspace_apple_local_transport_enabled=True,
    workspace_desktop_local_transport_enabled=True,
    beta_box_id=CONFIG["box"],
    clerk_issuer=CONFIG["issuer"],
    clerk_jwks_url=CONFIG["issuer"] + "/.well-known/jwks.json",
    clerk_audience=CONFIG["audience"],
    clerk_organization_id=CONFIG["organization"],
    clerk_authorized_parties="capacitor://localhost,app://cosmas",
    cors_allowed_origins="capacitor://localhost,app://cosmas",
)
if settings.workspace_authentication_errors():
    raise RuntimeError("Existing identity boundary is not configured")
engine = create_engine(
    "postgresql+psycopg:///" + CONFIG["database"],
    connect_args={
        "host": str(ROOT / "socket"),
        "port": CONFIG["database_port"],
        "options": "-c statement_timeout=5000 -c lock_timeout=2000",
    },
    hide_parameters=True,
)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
verifier = None


def stage(name: str) -> None:
    # Fixed metadata only. Never request bodies, tokens, subjects or IP addresses.
    with (ROOT / "server-stages.jsonl").open("a") as stream:
        stream.write(json.dumps({"at": datetime.now(UTC).isoformat(), "stage": name}) + "\n")


def response(status: int, body: object) -> JSONResponse:
    return JSONResponse(status_code=status, content=body, headers={"Cache-Control": "no-store"})


@app.middleware("http")
async def connection_boundary(request: Request, call_next):
    if (
        request.headers.get("host") != f"{CONFIG['address']}:{CONFIG['port']}"
        or request.headers.get("origin") not in {"capacitor://localhost", "app://cosmas"}
        or request.method != "GET"
        or request.url.path not in {"/connection", "/workspaces"}
        or request.url.query
    ):
        return response(404, {"detail": "unavailable"})
    try:
        return await call_next(request)
    except Exception:
        stage("receiver_unavailable")
        return response(503, {"detail": "unavailable"})


@app.get("/connection")
def connection():
    stage("private_tls_request_received")
    return response(200, {"connection": "w13-private-read-only"})


@app.get("/workspaces")
def workspaces(request: Request):
    global verifier
    if verifier is None:
        verifier = ClerkTokenVerifier(settings)
    try:
        with Session(engine) as session:
            identity = authenticate_request(
                session,
                settings,
                authorization=request.headers.get("authorization"),
                box_header=request.headers.get("x-box-id"),
                actor_header=request.headers.get("x-actor-principal-id"),
                verifier=verifier,
            )
            result = catalog(session, identity.box_id, identity.principal_id)
            stage("authenticated_catalog_returned")
            return response(200, result)
    except AuthenticationFailed:
        stage("jwt_rejected")
        return response(401, {"detail": "access_unavailable"})
    except (AccessDenied, WorkspaceError):
        stage("creator_access_rejected")
        return response(403, {"detail": "access_unavailable"})


if __name__ == "__main__":
    import uvicorn

    logging.disable(logging.CRITICAL)
    uvicorn.run(
        app,
        host=CONFIG["address"],
        port=CONFIG["port"],
        ssl_keyfile=str(ROOT / "tls/server-key.pem"),
        ssl_certfile=str(ROOT / "tls/server.pem"),
        access_log=False,
        log_config=None,
        server_header=False,
        proxy_headers=False,
        limit_concurrency=16,
        timeout_keep_alive=5,
    )
