"""Explicit transport to the existing Core AI account; no new endpoint resource."""

from __future__ import annotations

import asyncio
import socket
from collections.abc import Sequence
from ipaddress import ip_address

from .speech_private_network import (
    AddressResolver,
    IpNetwork,
    PrivateSpeechEndpointGuard,
)

CORE_POSTGRES_HOST = "cosmaneura-prod-postgres.postgres.database.azure.com"
CORE_SPEECH_HOST = "cosmaneuraprodopenai.cognitiveservices.azure.com"
CORE_OPENAI_HOST = "cosmaneuraprodopenai.openai.azure.com"
CORE_TRANSLATION_DEPLOYMENT = "gpt-4.1-2025-04-14"


class CoreAIEndpointUnavailable(RuntimeError):
    """Fixed-code denial before egress to an unqualified Core AI DNS answer."""


async def _addresses(hostname: str) -> tuple[str, ...]:
    records = await asyncio.get_running_loop().getaddrinfo(
        hostname,
        443,
        family=socket.AF_UNSPEC,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
    )
    return tuple(str(record[4][0]) for record in records)


class CoreAIPublicEndpointGuard:
    def __init__(self, hostname: str, *, resolver: AddressResolver | None = None):
        if hostname not in {CORE_SPEECH_HOST, CORE_OPENAI_HOST}:
            raise ValueError("existing_core_ai_endpoint_invalid")
        self.hostname, self.resolver = hostname, resolver or _addresses

    async def verify(self) -> None:
        try:
            answers = await self.resolver(self.hostname)
            if not answers or any(not ip_address(answer).is_global for answer in answers):
                raise ValueError
        except (OSError, UnicodeError, ValueError):
            raise CoreAIEndpointUnavailable("existing_core_ai_endpoint_unavailable") from None


def ai_endpoint_guard(
    hostname: str,
    private_networks: Sequence[IpNetwork],
    *,
    existing_core_public: bool = False,
) -> PrivateSpeechEndpointGuard | CoreAIPublicEndpointGuard:
    if not existing_core_public:
        return PrivateSpeechEndpointGuard(hostname, private_networks)
    if private_networks:
        raise ValueError("existing_core_ai_transport_mixed")
    return CoreAIPublicEndpointGuard(hostname)
