"""Opt-in ACA edge adapter; no server, cloud configuration or activation.

Forwarded headers do NOT prove their sender is trusted. Activation requires an
independently reviewed ingress/backend isolation configuration. The ASGI server
must disable proxy-header rewriting. No forwarded identity or client IP grants
authority. Runtime header behavior still needs installed Azure acceptance.
"""

from cosmaneura_scribe.safe_logging import log_event
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

STAGING_HOST = (
    "cosmaneura-staging-scribe-native.politesmoke-7989878f.northcentralus.azurecontainerapps.io"
)
STAGING_ORIGIN = "https://" + STAGING_HOST
ACA_PROFILE = "core-staging-aca-v1"
_FORWARDING = {b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host", b"x-forwarded-port"}
# Observed on the deployed ACA HTTPS edge. These values are discarded, never
# used for TLS, routing, identity or authorization; the actual ASGI path wins.
_DISCARDED_EDGE_METADATA = {b"x-arr-ssl", b"x-forwarded-path"}
_EDGE_HEADERS = _FORWARDING | _DISCARDED_EDGE_METADATA


class AzureIngress:
    def __init__(self, app: ASGIApp, *, profile: str | None = None) -> None:
        if profile not in (None, ACA_PROFILE):
            raise ValueError("provider_ingress_profile_invalid")
        self.app, self.profile = app, profile
        self._reported_rejections: set[str] = set()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        headers = scope.get("headers", [])
        names = [key.lower() for key, _ in headers]

        def values(name: bytes) -> list[bytes]:
            return [value for key, value in headers if key.lower() == name]

        invalid = (
            self.profile != ACA_PROFILE
            or scope["type"] != "http"
            or scope.get("scheme") != "http"
            or scope.get("root_path", "") != ""
            or values(b"host") != [STAGING_HOST.encode("ascii")]
            or values(b"x-forwarded-proto") != [b"https"]
            or (
                b"x-forwarded-host" in names
                and values(b"x-forwarded-host") != [STAGING_HOST.encode("ascii")]
            )
            or (b"x-forwarded-port" in names and values(b"x-forwarded-port") != [b"443"])
            or any(names.count(name) > 1 for name in _EDGE_HEADERS)
            or any(
                name == b"forwarded"
                or name.startswith((b"x-ms-client-", b"x-ms-token-"))
                or name.startswith((b"x-arr-", b"x-forwarded-"))
                and name not in _EDGE_HEADERS
                for name in names
            )
        )
        if invalid:
            # At most one event per fixed rejection class per process. Never log
            # request values, tokens, URLs, IP addresses or caller-selected names.
            for reason, rejected in (
                ("IngressProfile", self.profile != ACA_PROFILE),
                ("IngressScope", scope["type"] != "http"),
                ("IngressScheme", scope.get("scheme") != "http"),
                ("IngressRootPath", scope.get("root_path", "") != ""),
                ("IngressHost", values(b"host") != [STAGING_HOST.encode("ascii")]),
                ("IngressForwardedProto", values(b"x-forwarded-proto") != [b"https"]),
                (
                    "IngressForwardedHost",
                    b"x-forwarded-host" in names
                    and values(b"x-forwarded-host") != [STAGING_HOST.encode("ascii")],
                ),
                (
                    "IngressForwardedPort",
                    b"x-forwarded-port" in names and values(b"x-forwarded-port") != [b"443"],
                ),
                (
                    "IngressDuplicateForwarding",
                    any(names.count(name) > 1 for name in _EDGE_HEADERS),
                ),
                ("IngressForwarded", b"forwarded" in names),
                (
                    "IngressClientIdentity",
                    any(name.startswith((b"x-ms-client-", b"x-ms-token-")) for name in names),
                ),
                (
                    "IngressArr",
                    any(name.startswith(b"x-arr-") and name not in _EDGE_HEADERS for name in names),
                ),
                (
                    "IngressUnknownForwarding",
                    any(
                        name.startswith(b"x-forwarded-") and name not in _EDGE_HEADERS
                        for name in names
                    ),
                ),
                ("IngressClientCertificate", b"x-forwarded-client-cert" in names),
            ):
                if rejected and reason not in self._reported_rejections:
                    self._reported_rejections.add(reason)
                    log_event(action="receiver.ingress_rejected", error_class=reason)
            await JSONResponse(
                {"detail": "provider_unavailable"},
                status_code=404,
                headers={"Cache-Control": "no-store"},
            )(scope, receive, send)
            return
        # Static external authority after the deployment boundary, never an
        # authority, URL or principal constructed from caller-selected headers.
        normalized = dict(scope, scheme="https", server=(STAGING_HOST, 443), client=None)
        normalized["headers"] = [
            (key, value) for key, value in headers if key.lower() not in _EDGE_HEADERS
        ]
        await self.app(normalized, receive, send)
