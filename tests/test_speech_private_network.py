from __future__ import annotations

from ipaddress import ip_network

import pytest
from cosmaneura_scribe.speech_private_network import (
    IpNetwork,
    PrivateSpeechEndpointGuard,
    PrivateSpeechEndpointUnavailable,
)


@pytest.mark.asyncio
async def test_private_speech_guard_accepts_only_expected_private_endpoint_subnet() -> None:
    observed: list[str] = []

    async def resolve(hostname: str) -> tuple[str, ...]:
        observed.append(hostname)
        return ("10.42.1.7",)

    guard = PrivateSpeechEndpointGuard(
        "cosmaneura-scribe-dev-speech.cognitiveservices.azure.com",
        (ip_network("10.42.1.7/32"),),
        resolver=resolve,
    )

    await guard.verify()

    assert observed == ["cosmaneura-scribe-dev-speech.cognitiveservices.azure.com"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "addresses",
    [
        (),
        ("20.42.1.7",),
        ("10.42.2.7",),
        ("10.42.1.7", "20.42.1.7"),
        ("not-an-ip",),
    ],
)
async def test_private_speech_guard_fails_closed_for_unsafe_dns_answers(
    addresses: tuple[str, ...],
) -> None:
    async def resolve(_: str) -> tuple[str, ...]:
        return addresses

    guard = PrivateSpeechEndpointGuard(
        "cosmaneura-scribe-dev-speech.cognitiveservices.azure.com",
        (ip_network("10.42.1.7/32"),),
        resolver=resolve,
    )

    with pytest.raises(
        PrivateSpeechEndpointUnavailable,
        match="^speech_private_endpoint_unavailable$",
    ):
        await guard.verify()


@pytest.mark.asyncio
async def test_private_speech_guard_sanitizes_dns_resolution_failure() -> None:
    async def resolve(_: str) -> tuple[str, ...]:
        raise OSError("unsafe endpoint and resolver details")

    guard = PrivateSpeechEndpointGuard(
        "cosmaneura-scribe-dev-speech.cognitiveservices.azure.com",
        (ip_network("10.42.1.7/32"),),
        resolver=resolve,
    )

    with pytest.raises(PrivateSpeechEndpointUnavailable) as caught:
        await guard.verify()

    assert str(caught.value) == "speech_private_endpoint_unavailable"
    assert "resolver" not in repr(caught.value)


@pytest.mark.parametrize(
    "allowed_networks",
    [
        (ip_network("20.42.1.7/32"),),
        (ip_network("10.42.1.0/24"),),
        (ip_network("10.42.1.7/32"), ip_network("10.42.1.8/32")),
        (ip_network("10.42.1.7/32"), ip_network("fd00::7/128")),
    ],
)
def test_private_speech_guard_rejects_nonexact_allowlist(
    allowed_networks: tuple[IpNetwork, ...],
) -> None:
    with pytest.raises(ValueError, match="one private host CIDR"):
        PrivateSpeechEndpointGuard(
            "cosmaneura-scribe-dev-speech.cognitiveservices.azure.com",
            allowed_networks,
        )
