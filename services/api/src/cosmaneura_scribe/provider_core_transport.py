"""Dormant server transport for the standalone provider's existing Core facade.

The authenticated host supplies fresh, normalized creator/encounter context.
Core still decides session, mount and clinical authority. This module does not
parse vendor claims, expose an HTTP route, acquire credentials from the renderer,
or register a runtime. Workload and mount credentials never leave this transport.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http.cookiejar import Cookie, CookieJar, DefaultCookiePolicy
from typing import cast
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
from pydantic import SecretStr

from .source_start_contract import SourceStartIntent

_ROOT = "/service/v1/agent/scribe/"
MAX_CORE_CAPTURE_RESPONSE_BYTES = 32 * 1024 * 1024 + 8192
_ACTIONS = frozenset({"capture-admissions", "capture-operations", "capture-notes"})
_OPERATIONS = frozenset(
    {
        "encryption_key",
        "bind_key",
        "capabilities",
        "issue_lease",
        "renew_lease",
        "reserve_chunks",
        "authorize_upload",
        "chunk_receipt",
        "register_chunk",
        "complete",
        "creator_review",
        "decide_translation",
    }
)
_SCOPE_KEYS = {"binding_ref", "workspace_id", "request_nonce"}
# Core can complete two 65-second admission phases. These are HTTP wait
# budgets only; they never extend a consent, capture lease or start decision.
ADMISSION_CORE_TIMEOUT_SECONDS = 140
ADMISSION_TOTAL_TIMEOUT_SECONDS = 180


class _NoCookies(DefaultCookiePolicy):
    """Core access here uses explicit credentials, never shared browser state."""

    def set_ok(self, cookie: Cookie, request: object) -> bool:
        return False

    def return_ok(self, cookie: Cookie, request: object) -> bool:
        return False


class ProviderCoreUnavailable(Exception):
    """Fixed, value-free error; an uncertain mutation is never retried here."""

    def __init__(self, code: str = "core_provider_receipt_invalid", status: int = 503):
        self.code = code
        self.status = status
        super().__init__(code)


@dataclass(frozen=True, repr=False)
class CoreProviderSelection:
    """Server-bound values from current identity, grant and Core account records.

    recovery_scope is stable for this environment/creator. authorization_revision
    changes when the host session or its identity changes. Neither comes from a
    provider form, URL, unverified claim or client-supplied authority header.
    """

    recovery_scope: UUID
    authorization_revision: UUID
    workspace_id: UUID
    appointment_ref: str
    actor_ref: str
    tenant_ref: str

    def __post_init__(self) -> None:
        for value in (
            self.recovery_scope,
            self.authorization_revision,
            self.workspace_id,
        ):
            _checked(value, UUID)
        for value, prefix in (
            (self.appointment_ref, "appointment"),
            (self.actor_ref, "authority_actor"),
            (self.tenant_ref, "authority_tenant"),
        ):
            _require(_reference(value, prefix))


@dataclass(frozen=True, repr=False)
class AuthorizedCoreProvider:
    selection: CoreProviderSelection
    user_token: SecretStr


@dataclass(frozen=True, repr=False)
class CoreProviderMount:
    selection: CoreProviderSelection
    binding_ref: str

    def client_scope(self) -> dict[str, str]:
        """Only the identifiers required by createProviderIOSHost/CoreCaptureClient."""
        return {
            "recoveryScope": str(self.selection.recovery_scope),
            "workspaceId": str(self.selection.workspace_id),
            "appointmentRef": self.selection.appointment_ref,
            "bindingRef": self.binding_ref,
        }


@dataclass(frozen=True, repr=False)
class _NegotiatedMount:
    mount: CoreProviderMount
    token: SecretStr
    interaction_ref: str
    turn: UUID

    def headers(self) -> dict[str, str]:
        return {
            "X-Cosmaneura-Mount-Context": _secret(self.token),
            "X-Cosmaneura-Interaction-Ref": self.interaction_ref,
            "X-Cosmaneura-Client-Turn-ID": str(self.turn),
            "X-Cosmaneura-Capture-Version": "1",
        }


class ProviderCoreTransport:
    """Fixed Core routes, per-operation authorization, bounded replies, no retries.

    fresh_context must recheck the actual host identity, beta grant, creator and
    selected encounter every time, including after I/O. It must raise on logout
    or revocation. No default or permissive implementation is provided.
    """

    def __init__(
        self,
        origin: str,
        fresh_context: Callable[[], Awaitable[AuthorizedCoreProvider]],
        workload_token: Callable[[], Awaitable[SecretStr]],
        *,
        enabled: bool = False,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        try:
            url = urlsplit(origin)
            valid = (
                url.scheme == "https"
                and bool(url.hostname)
                and url.port != 0
                and not url.username
                and not url.password
                and url.path in ("", "/")
                and not url.query
                and not url.fragment
                and not any(c.isspace() or ord(c) < 33 for c in origin)
            )
        except ValueError:
            valid = False
        if not valid:
            raise ProviderCoreUnavailable("core_provider_origin_invalid")
        self._origin = origin.rstrip("/")
        self._fresh_context = fresh_context
        self._workload_token = workload_token
        self._enabled = enabled is True
        self._clock = clock
        self._client = httpx.AsyncClient(
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(20, connect=5),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
            cookies=CookieJar(policy=_NoCookies()),
        )

    async def close(self) -> None:
        self._enabled = False
        await self._client.aclose()

    async def open(self) -> CoreProviderMount:
        """Resolve the selected encounter without admitting or starting recording."""
        return (await self._negotiate(None)).mount

    async def request(
        self,
        mount: CoreProviderMount,
        path: str,
        body: Mapping[str, object],
        key: str,
        *,
        native_start: bool = False,
    ) -> dict[str, object]:
        try:
            async with asyncio.timeout(
                ADMISSION_TOTAL_TIMEOUT_SECONDS if path == _ROOT + "capture-admissions" else None
            ):
                return await self._request(mount, path, body, key, native_start=native_start)
        except TimeoutError:
            raise ProviderCoreUnavailable("core_provider_request_timeout") from None

    async def _request(
        self,
        mount: CoreProviderMount,
        path: str,
        body: Mapping[str, object],
        key: str,
        *,
        native_start: bool = False,
    ) -> dict[str, object]:
        """Accept exactly the current provider client's three facade operations.

        The host forwards only the returned body with no-store. On an uncertain
        mutation, the provider retains its original key/body for explicit recovery.
        """
        _checked(mount, CoreProviderMount)
        _checked(path, str)
        action = path.removeprefix(_ROOT)
        _require(path == _ROOT + action and action in _ACTIONS)
        _require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", _checked(key, str)))
        payload = _snapshot(
            body,
            {
                "capture-admissions": 2048,
                "capture-operations": 4_194_304,
                "capture-notes": 262_144 + 8192,
            }[action],
        )
        _validate_intent(mount, action, payload, native_start=native_start)
        current = await self._negotiate(mount.selection)
        _require(current.mount == mount)
        headers = {**await self._workload_headers(), **current.headers()}
        headers["Idempotency-Key"] = key
        # Credentials remain request-local even when this connection is used
        # concurrently for progress reads and an explicit provider action.
        value, _ = await self._send(
            mount.selection,
            path,
            payload,
            headers,
            version=("X-Cosmaneura-Capture-Version", "1"),
            max_bytes=MAX_CORE_CAPTURE_RESPONSE_BYTES
            if action == "capture-operations"
            else 8 * 1024 * 1024,
            request_timeout=ADMISSION_CORE_TIMEOUT_SECONDS
            if action == "capture-admissions"
            else 100
            if action == "capture-notes" and payload.get("action") == "prepare"
            else 20,
        )
        _require(
            value.get("contract_version") == "1"
            and value.get("binding_ref") == mount.binding_ref
            and value.get("workspace_id") == str(mount.selection.workspace_id)
            and value.get("request_nonce") == payload["request_nonce"]
        )
        self._recent(value.get("checked_at"))
        if action == "capture-admissions":
            _require(
                value.get("appointment_ref") == mount.selection.appointment_ref
                and _reference(value.get("operation_ref"), "scribe_admission")
            )
            _uuid(value.get("session_id"))
            _uuid(value.get("consent_record_id"))
        else:
            receipt = _object(value.get("receipt"))
            if action == "capture-operations":
                _require(value.get("operation") == _object(payload["operation"])["kind"])
            else:
                _require(
                    value.get("action") == payload["action"]
                    and receipt.get("session_id") == payload["expected_session_id"]
                )
        return value

    async def _context(self, expected: CoreProviderSelection | None) -> AuthorizedCoreProvider:
        if not self._enabled:
            raise ProviderCoreUnavailable("core_provider_unavailable")
        try:
            async with asyncio.timeout(10):
                context = _checked(await self._fresh_context(), AuthorizedCoreProvider)
            _require(self._enabled)
            _checked(context.selection, CoreProviderSelection)
            _require(expected is None or context.selection == expected)
            _secret(context.user_token)
            return context
        except Exception:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403) from None

    async def _workload_headers(self) -> dict[str, str]:
        try:
            async with asyncio.timeout(10):
                value = await self._workload_token()
            return {"Authorization": "Bearer " + _secret(value)}
        except Exception:
            raise ProviderCoreUnavailable("core_provider_workload_unavailable") from None

    async def _negotiate(self, expected: CoreProviderSelection | None) -> _NegotiatedMount:
        context = await self._context(expected)
        selection = context.selection
        issued, _ = await self._send(
            selection,
            "/embed/v1/context-tokens/exchange",
            {"requested_surface": "provider_assistant", "record_ref": selection.appointment_ref},
            {
                "Authorization": "Bearer " + _secret(context.user_token),
                "X-Cosmaneura-Embed-Version": "1.0",
            },
            status=201,
            version=("X-Cosmaneura-Embed-Version", "1.0"),
        )
        stamp = self._recent(issued.get("issued_at"))
        try:
            refresh = datetime.fromisoformat(_string(issued.get("refresh_after")))
            expiry = datetime.fromisoformat(_string(issued.get("expires_at")))
            _require(
                stamp < refresh < expiry
                and expiry > self._clock()
                and issued.get("token_type") == "Bearer"
            )
        except (ValueError, TypeError):
            raise ProviderCoreUnavailable() from None
        token = SecretStr(_string(issued.get("context_token")))
        _secret(token)
        turn = uuid4()
        resolved, response_headers = await self._send(
            selection,
            "/service/v1/agent/mount-context/resolve",
            None,
            {
                **await self._workload_headers(),
                "X-Cosmaneura-Mount-Context": _secret(token),
                "X-Cosmaneura-Client-Turn-ID": str(turn),
            },
        )
        _require(
            resolved.get("surface") == "provider_assistant"
            and resolved.get("auth_tier") == "provider"
            and resolved.get("actor_id") == selection.actor_ref
            and resolved.get("tenant_id") == selection.tenant_ref
            and response_headers.get("X-Cosmaneura-Client-Turn-ID") == str(turn)
        )
        interaction = response_headers.get("X-Cosmaneura-Interaction-Ref", "")
        _require(re.fullmatch(r"[A-Za-z0-9._~-]{16,160}", interaction))
        headers = {
            "X-Cosmaneura-Mount-Context": _secret(token),
            "X-Cosmaneura-Client-Turn-ID": str(turn),
            "X-Cosmaneura-Interaction-Ref": interaction,
            "X-Cosmaneura-Capture-Version": "1",
        }
        nonce = str(uuid4())
        binding, _ = await self._send(
            selection,
            _ROOT + "capture-bindings/resolve",
            {
                "workspace_id": str(selection.workspace_id),
                "appointment_ref": selection.appointment_ref,
                "request_nonce": nonce,
            },
            {**await self._workload_headers(), **headers},
            version=("X-Cosmaneura-Capture-Version", "1"),
        )
        _require(
            binding.get("contract_version") == "1"
            and binding.get("workspace_id") == str(selection.workspace_id)
            and binding.get("appointment_ref") == selection.appointment_ref
            and binding.get("actor_ref") == selection.actor_ref
            and binding.get("tenant_ref") == selection.tenant_ref
            and binding.get("request_nonce") == nonce
            and _reference(binding.get("binding_ref"), "scribe_capture_binding")
        )
        self._recent(binding.get("checked_at"))
        return _NegotiatedMount(
            CoreProviderMount(selection, _string(binding["binding_ref"])),
            token,
            interaction,
            turn,
        )

    async def _send(
        self,
        selection: CoreProviderSelection,
        path: str,
        payload: object,
        headers: Mapping[str, str],
        *,
        status: int = 200,
        version: tuple[str, str] | None = None,
        max_bytes: int = 16_384,
        request_timeout: float = 20,
    ) -> tuple[dict[str, object], httpx.Headers]:
        await self._context(selection)
        try:
            async with self._client.stream(
                "POST",
                self._origin + path,
                json=payload,
                timeout=httpx.Timeout(request_timeout, connect=5),
                headers={"Accept": "application/json", "Cache-Control": "no-store", **headers},
            ) as response:
                if response.status_code in {401, 403, 404, 410}:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                if response.status_code != status:
                    if (
                        path == _ROOT + "capture-admissions"
                        and response.status_code == 409
                        and response.headers.get("X-Cosmaneura-Capture-Version") == "1"
                        and response.headers.get("content-type", "")
                        .split(";", 1)[0]
                        .strip()
                        .lower()
                        == "application/problem+json"
                        and "no-store"
                        in {
                            item.strip().lower()
                            for item in response.headers.get("cache-control", "").split(",")
                        }
                    ):
                        failure_bytes = bytearray()
                        async for chunk in response.aiter_bytes():
                            _require(len(failure_bytes) + len(chunk) <= 2048)
                            failure_bytes.extend(chunk)
                        failure = _decode(failure_bytes)
                        if (
                            failure.get("code") == "CAPTURE_CONSENT_REQUIRED"
                            and failure.get("status") == 409
                            and failure.get("retryable") is False
                        ):
                            await self._context(selection)
                            raise ProviderCoreUnavailable("core_provider_consent_required", 409)
                    code, result = {
                        409: ("core_provider_conflict", 409),
                        202: ("core_provider_pending", 503),
                    }.get(response.status_code, ("core_provider_request_unconfirmed", 503))
                    raise ProviderCoreUnavailable(code, result)
                _require(
                    response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    == "application/json"
                )
                _require(
                    "no-store"
                    in {
                        p.strip().lower()
                        for p in response.headers.get("cache-control", "").split(",")
                    }
                )
                if version:
                    _require(response.headers.get(version[0]) == version[1])
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    _require(len(data) + len(chunk) <= max_bytes)
                    data.extend(chunk)
                value = _decode(data)
                response_headers = httpx.Headers(response.headers)
            await self._context(selection)
            return value, response_headers
        except httpx.HTTPError:
            raise ProviderCoreUnavailable("core_provider_request_unconfirmed") from None

    def _recent(self, value: object) -> datetime:
        try:
            _require(isinstance(value, str))
            stamp = datetime.fromisoformat(cast(str, value))
            now = self._clock()
            _require(
                stamp.tzinfo is not None
                and now.tzinfo is not None
                and now - timedelta(seconds=30) <= stamp <= now + timedelta(seconds=5)
            )
            return stamp
        except (ValueError, TypeError):
            raise ProviderCoreUnavailable() from None


def _validate_intent(
    mount: CoreProviderMount,
    action: str,
    body: dict[str, object],
    *,
    native_start: bool = False,
) -> None:
    _require(
        body.get("binding_ref") == mount.binding_ref
        and body.get("workspace_id") == str(mount.selection.workspace_id)
    )
    _uuid(body.get("request_nonce"))
    keys = set(body) - _SCOPE_KEYS
    if native_start:
        _require(action == "capture-operations" and keys == {"operation"})
        operation = _object(body["operation"])
        _require(
            set(operation) == {"kind", "action", "payload"}
            and operation.get("kind") == "source_start"
            and operation.get("action") in {"prepare", "authorize", "cancel", "stop"}
        )
        try:
            SourceStartIntent.model_validate(operation["payload"])
        except ValueError:
            raise ProviderCoreUnavailable() from None
        return
    if action == "capture-admissions":
        _require(keys == {"attestation", "configured_capture"})
        configured = _object(body["configured_capture"])
        _require(
            set(configured) == {"schema_version", "language_mode"}
            and configured.get("schema_version") == "1.0"
            and configured.get("language_mode") in ("en-US", "en-US+es-US")
        )
    elif action == "capture-operations":
        _require(keys == {"operation"})
        operation = _object(body["operation"])
        _require(isinstance(operation.get("kind"), str) and operation.get("kind") in _OPERATIONS)
    else:
        _require(keys <= {"expected_session_id", "schema_ref", "action", "edit"})
        _uuid(body.get("expected_session_id"))
        _require(body.get("action") in ("templates", "read", "prepare", "save", "resolve"))


def _require(condition: object) -> None:
    if not condition:
        raise ProviderCoreUnavailable()


def _checked[T](value: object, kind: type[T]) -> T:
    if not isinstance(value, kind):
        raise ProviderCoreUnavailable()
    return value


def _reference(value: object, prefix: str) -> bool:
    return (
        isinstance(value, str)
        and re.fullmatch(prefix + r"_[0-7][0-9a-hjkmnp-tv-z]{25}", value) is not None
    )


def _object(value: object) -> dict[str, object]:
    _require(isinstance(value, dict))
    return cast(dict[str, object], value)


def _string(value: object) -> str:
    _require(isinstance(value, str))
    return cast(str, value)


def _uuid(value: object) -> str:
    try:
        _require(isinstance(value, str) and str(UUID(value)) == value)
        return cast(str, value)
    except ValueError:
        raise ProviderCoreUnavailable() from None


def _secret(value: SecretStr) -> str:
    raw = _checked(value, SecretStr).get_secret_value()
    _require(16 <= len(raw) <= 8192 and raw.isascii() and all(33 <= ord(c) <= 126 for c in raw))
    return raw


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        _require(key not in value)
        value[key] = item
    return value


def _decode(data: bytes | bytearray) -> dict[str, object]:
    try:
        value: object = json.loads(
            data, object_pairs_hook=_pairs, parse_constant=lambda _: _require(False)
        )
        _require(isinstance(value, dict))
        return cast(dict[str, object], value)
    except (ValueError, TypeError, RecursionError):
        raise ProviderCoreUnavailable() from None


def _snapshot(body: Mapping[str, object], maximum: int) -> dict[str, object]:
    try:
        data = json.dumps(dict(body), allow_nan=False, separators=(",", ":")).encode("utf-8")
        _require(len(data) <= maximum)
        return _decode(data)
    except (ValueError, TypeError, RecursionError):
        raise ProviderCoreUnavailable() from None
