from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Protocol, cast
from urllib.parse import urlsplit

import httpx
from azure.core.credentials import AccessToken
from azure.core.exceptions import AzureError
from azure.identity.aio import DefaultAzureCredential
from pydantic import ValidationError

from .schemas import AudioEncryptionPublicKey, RsaPublicJwk

if TYPE_CHECKING:
    from .settings import Settings

KEY_VAULT_SCOPE = "https://vault.azure.net/.default"
KEY_VAULT_DNS_SUFFIX = ".vault.azure.net"


class AudioEncryptionKeyUnavailable(RuntimeError):
    """Fixed-code public-key publication failure safe for operational logs."""


class KeyVaultTokenCredential(Protocol):
    async def get_token(
        self,
        *scopes: str,
        claims: str | None = None,
        tenant_id: str | None = None,
        enable_cae: bool = False,
        **kwargs: Any,
    ) -> AccessToken: ...

    async def close(self) -> None: ...


class AudioEncryptionKeyProvider(Protocol):
    async def get_public_key(self) -> AudioEncryptionPublicKey: ...

    def versioned_key_id(self, key_version: str) -> str | None: ...

    async def close(self) -> None: ...


class BorrowedAudioEncryptionKeyProvider:
    """Request-local handle; the application owns transport and credential cleanup.

    Every read still asks the provider for its current Key Vault key. Closing a
    handle prevents further use without closing resources used by other requests.
    """

    def __init__(self, provider: AudioEncryptionKeyProvider) -> None:
        self._provider = provider
        self._closed = False

    async def get_public_key(self) -> AudioEncryptionPublicKey:
        if self._closed:
            raise AudioEncryptionKeyUnavailable("audio_encryption_key_unavailable")
        result = await self._provider.get_public_key()
        if self._closed:
            raise AudioEncryptionKeyUnavailable("audio_encryption_key_unavailable")
        return result

    def versioned_key_id(self, key_version: str) -> str | None:
        return None if self._closed else self._provider.versioned_key_id(key_version)

    async def close(self) -> None:
        self._closed = True


class UnavailableAudioEncryptionKeyProvider:
    async def get_public_key(self) -> AudioEncryptionPublicKey:
        raise AudioEncryptionKeyUnavailable("audio_encryption_key_unavailable")

    def versioned_key_id(self, key_version: str) -> str | None:
        del key_version
        return None

    async def close(self) -> None:
        return None


class KeyVaultAudioEncryptionKeyProvider:
    def __init__(
        self,
        *,
        configured_key_id: str,
        credential: KeyVaultTokenCredential,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        normalized_key_id = versionless_key_id(configured_key_id)
        if normalized_key_id is None:
            raise ValueError("configured_key_id must be a versionless Azure Key Vault key ID")
        self._configured_key_id = normalized_key_id
        self._credential = credential
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=15,
            trust_env=False,
            follow_redirects=False,
        )

    async def get_public_key(self) -> AudioEncryptionPublicKey:
        try:
            token = await self._credential.get_token(KEY_VAULT_SCOPE)
            response = await self._client.get(
                self._configured_key_id,
                params={"api-version": "7.4"},
                headers={"Authorization": f"Bearer {token.token}"},
            )
        except (AzureError, httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError):
            raise AudioEncryptionKeyUnavailable("audio_encryption_key_unavailable") from None
        if response.status_code != 200:
            raise AudioEncryptionKeyUnavailable("audio_encryption_key_unavailable")
        try:
            payload = response.json()
            key = payload["key"]
            attributes = payload["attributes"]
            key_id = key["kid"]
            modulus = key["n"]
            exponent = key["e"]
            key_type = key["kty"]
            key_operations = key["key_ops"]
            if not all(isinstance(value, str) for value in (key_id, modulus, exponent)):
                raise ValueError
            if key_type != "RSA" or not isinstance(key_operations, list):
                raise ValueError
            if not _key_is_currently_enabled(attributes, now=time.time()):
                raise ValueError
            operation_values = cast(list[object], key_operations)
            if not all(isinstance(operation, str) for operation in operation_values):
                raise ValueError
            operations = cast(list[str], operation_values)
            if not {"wrapKey", "unwrapKey"}.issubset(operations):
                raise ValueError
            key_version = _version_from_key_id(key_id)
            authorized = authorized_key_version(
                self._configured_key_id,
                key_id,
                key_version,
            )
            if authorized is None:
                raise ValueError
            return AudioEncryptionPublicKey(
                key_version=key_version,
                public_jwk=RsaPublicJwk(n=modulus, e=exponent),
            )
        except (KeyError, TypeError, ValueError, ValidationError):
            raise AudioEncryptionKeyUnavailable("audio_encryption_key_unavailable") from None

    def versioned_key_id(self, key_version: str) -> str | None:
        return versioned_key_id(self._configured_key_id, key_version)

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()
        await self._credential.close()


def authorized_key_version(
    configured_key_id: str,
    candidate_key_id: str,
    key_version: str,
) -> str | None:
    configured = _parse_key_url(configured_key_id)
    candidate = _parse_key_url(candidate_key_id)
    if configured is None or candidate is None:
        return None
    configured_host, configured_parts = configured
    candidate_host, candidate_parts = candidate
    if configured_host != candidate_host or len(configured_parts) != 2:
        return None
    if len(candidate_parts) != 3 or candidate_parts[:2] != configured_parts:
        return None
    if candidate_parts[2] != key_version or _valid_version(key_version) is False:
        return None
    return f"https://{candidate_host}/{'/'.join(candidate_parts)}"


def versioned_key_id(configured_key_id: str, key_version: str) -> str | None:
    configured = _parse_key_url(configured_key_id)
    if configured is None or len(configured[1]) != 2 or _valid_version(key_version) is False:
        return None
    host, parts = configured
    return f"https://{host}/{'/'.join((*parts, key_version))}"


def versionless_key_id(configured_key_id: str) -> str | None:
    configured = _parse_key_url(configured_key_id)
    if configured is None or len(configured[1]) != 2:
        return None
    host, parts = configured
    return f"https://{host}/{'/'.join(parts)}"


def _parse_key_url(value: str) -> tuple[str, tuple[str, ...]] | None:
    try:
        parsed = urlsplit(value.rstrip("/"))
        port = parsed.port
    except ValueError:
        return None
    hostname = parsed.hostname.casefold() if parsed.hostname is not None else None
    if (
        parsed.scheme.casefold() != "https"
        or hostname is None
        or not _valid_key_vault_hostname(hostname)
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.query
        or parsed.fragment
        or "%" in parsed.path
    ):
        return None
    parts = tuple(part for part in parsed.path.split("/") if part)
    if (
        not parts
        or parts[0] != "keys"
        or len(parts) not in {2, 3}
        or parsed.path != f"/{'/'.join(parts)}"
        or not _valid_key_name(parts[1])
    ):
        return None
    return hostname, parts


def _version_from_key_id(key_id: str) -> str:
    parsed = _parse_key_url(key_id)
    if parsed is None or len(parsed[1]) != 3:
        raise ValueError("invalid Key Vault key ID")
    return parsed[1][2]


def _valid_version(value: str) -> bool:
    return 1 <= len(value) <= 128 and all(
        character.isascii() and (character.isalnum() or character in "_-") for character in value
    )


def _valid_key_vault_hostname(value: str) -> bool:
    if not value.endswith(KEY_VAULT_DNS_SUFFIX):
        return False
    vault_name = value[: -len(KEY_VAULT_DNS_SUFFIX)]
    return (
        3 <= len(vault_name) <= 24
        and vault_name[0].isalpha()
        and vault_name[-1].isalnum()
        and "--" not in vault_name
        and all(
            character.isascii() and (character.isalnum() or character == "-")
            for character in vault_name
        )
    )


def _valid_key_name(value: str) -> bool:
    return 1 <= len(value) <= 127 and all(
        character.isascii() and (character.isalnum() or character == "-") for character in value
    )


def _key_is_currently_enabled(value: object, *, now: float) -> bool:
    if not isinstance(value, dict):
        return False
    attributes = cast(dict[str, object], value)
    if attributes.get("enabled") is not True:
        return False
    not_before = attributes.get("nbf")
    expires = attributes.get("exp")
    if not_before is not None and (
        isinstance(not_before, bool) or not isinstance(not_before, (int, float)) or now < not_before
    ):
        return False
    return not (
        expires is not None
        and (isinstance(expires, bool) or not isinstance(expires, (int, float)) or now >= expires)
    )


def build_audio_encryption_key_provider(settings: Settings) -> AudioEncryptionKeyProvider:
    if settings.audio_encryption_key_id is None:
        return UnavailableAudioEncryptionKeyProvider()
    credential = DefaultAzureCredential(
        managed_identity_client_id=(
            str(settings.managed_identity_client_id)
            if settings.managed_identity_client_id is not None
            else None
        ),
        require_envvar=False,
    )
    return KeyVaultAudioEncryptionKeyProvider(
        configured_key_id=str(settings.audio_encryption_key_id),
        credential=credential,
    )
