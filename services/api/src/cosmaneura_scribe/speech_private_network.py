from __future__ import annotations

import asyncio
import socket
from collections.abc import Awaitable, Callable, Sequence
from ipaddress import (
    IPv4Address,
    IPv4Network,
    IPv6Address,
    IPv6Network,
    ip_address,
    ip_network,
)

IpAddress = IPv4Address | IPv6Address
IpNetwork = IPv4Network | IPv6Network
AddressResolver = Callable[[str], Awaitable[Sequence[str]]]

_PRIVATE_NETWORKS: tuple[IpNetwork, ...] = (
    ip_network("10.0.0.0/8"),
    ip_network("172.16.0.0/12"),
    ip_network("192.168.0.0/16"),
    ip_network("fc00::/7"),
)


class PrivateSpeechEndpointUnavailable(RuntimeError):
    """Fixed-code failure raised before Speech egress when private DNS is unsafe."""


async def _resolve_addresses(hostname: str) -> tuple[str, ...]:
    loop = asyncio.get_running_loop()
    records = await loop.getaddrinfo(
        hostname,
        443,
        family=socket.AF_UNSPEC,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
    )
    return tuple(str(record[4][0]) for record in records)


def _is_private_network(network: IpNetwork) -> bool:
    if isinstance(network, IPv4Network):
        return any(
            isinstance(private_network, IPv4Network) and network.subnet_of(private_network)
            for private_network in _PRIVATE_NETWORKS
        )
    return any(
        isinstance(private_network, IPv6Network) and network.subnet_of(private_network)
        for private_network in _PRIVATE_NETWORKS
    )


def _is_allowed_address(address: IpAddress, allowed_networks: tuple[IpNetwork, ...]) -> bool:
    if not any(
        address.version == private_network.version and address in private_network
        for private_network in _PRIVATE_NETWORKS
    ):
        return False
    return any(
        address.version == allowed_network.version and address in allowed_network
        for allowed_network in allowed_networks
    )


class PrivateSpeechEndpointGuard:
    """Require every Speech DNS answer to stay inside an approved private endpoint subnet."""

    def __init__(
        self,
        hostname: str,
        allowed_networks: Sequence[IpNetwork],
        *,
        resolver: AddressResolver | None = None,
    ) -> None:
        networks = tuple(allowed_networks)
        if (
            len(networks) != 1
            or networks[0].prefixlen != networks[0].max_prefixlen
            or not _is_private_network(networks[0])
        ):
            raise ValueError("speech private endpoint allowlist must be one private host CIDR")
        self._hostname = hostname
        self._allowed_networks = networks
        self._resolver = resolver or _resolve_addresses

    async def verify(self) -> None:
        try:
            resolved = await self._resolver(self._hostname)
            addresses = tuple(ip_address(value.split("%", maxsplit=1)[0]) for value in resolved)
        except (OSError, UnicodeError, ValueError):
            raise PrivateSpeechEndpointUnavailable("speech_private_endpoint_unavailable") from None
        if not addresses or any(
            not _is_allowed_address(address, self._allowed_networks) for address in addresses
        ):
            raise PrivateSpeechEndpointUnavailable("speech_private_endpoint_unavailable")
