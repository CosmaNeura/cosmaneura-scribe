"""Dormant server transport for the standalone provider's existing Core facade.

The authenticated host supplies fresh, normalized creator/encounter context.
Core still decides session, mount and clinical authority. This module does not
parse vendor claims, expose an HTTP route, acquire credentials from the renderer,
or register a runtime. Workload and mount credentials never leave this transport.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http.cookiejar import Cookie, CookieJar, DefaultCookiePolicy
from typing import cast
from urllib.parse import urlsplit
from uuid import UUID, uuid4, uuid5

import httpx
from pydantic import SecretStr

from .provider_core_connections import ProviderCoreConnections
from .provider_performance import provider_phase_timing
from .source_start_contract import SourceStartCapability, SourceStartIntent, SourceStartReceipt

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
        "provider_encounter",
        "native_recording_context",
        "preparation_metadata",
        "prepare_recording_window",
        "prepare_continuation_window",
        "decide_translation",
        "edit_transcript",
    }
)
_SCOPE_KEYS = {"binding_ref", "workspace_id", "request_nonce"}
# Core can complete two 65-second admission phases. These are HTTP wait
# budgets only; they never extend a consent, capture lease or start decision.
ADMISSION_CORE_TIMEOUT_SECONDS = 140
ADMISSION_TOTAL_TIMEOUT_SECONDS = 180
NOTE_OPENING_TOTAL_TIMEOUT_SECONDS = 100


def provider_cookie_jar() -> CookieJar:
    """Share the existing no-cookie policy with other fixed Core transports."""
    return CookieJar(policy=_NoCookies())


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


@dataclass(repr=False)
class _OpeningSequence:
    """One composed request; a post-I/O check is the next adjacent pre-I/O check.

    All workload credential I/O precedes the shared boundary. Taking the context
    is synchronous, and dispatch must follow without any intervening await.
    The final operation closes this object; it cannot authorize another request.
    """

    context: AuthorizedCoreProvider | None = None
    workload_headers: dict[str, str] | None = None
    closed: bool = False

    def take(self) -> AuthorizedCoreProvider:
        _require(not self.closed and self.context is not None)
        value = _checked(self.context, AuthorizedCoreProvider)
        self.context = None
        return value

    def headers(self) -> dict[str, str]:
        _require(not self.closed and self.workload_headers is not None)
        return dict(cast(dict[str, str], self.workload_headers))

    def close(self) -> None:
        self.context = None
        self.workload_headers = None
        self.closed = True


@dataclass(frozen=True, repr=False)
class _NegotiatedMount:
    mount: CoreProviderMount
    token: SecretStr
    interaction_ref: str
    turn: UUID
    opening: _OpeningSequence | None = None

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
        connections: ProviderCoreConnections | None = None,
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
        if connections is not None and transport is not None:
            raise ProviderCoreUnavailable("core_provider_transport_invalid")
        self._client = httpx.AsyncClient(
            transport=connections.borrow(self._origin) if connections is not None else transport,
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

    async def open_with_review(
        self, request_nonce: UUID, key: str
    ) -> tuple[CoreProviderMount, dict[str, object]]:
        """Resolve and read in one opening request, never cache mount authority.

        The existing provider_encounter read still checks current Core access.
        Its negotiated credentials stay local to this call; subsequent actions
        must negotiate again, including recorder preparation and source start.
        """
        _checked(request_nonce, UUID)
        _require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", _checked(key, str)))
        current = await self._negotiate(None, opening=True)
        mount = current.mount
        review = await self._request(
            mount,
            _ROOT + "capture-operations",
            {
                "workspace_id": str(mount.selection.workspace_id),
                "binding_ref": mount.binding_ref,
                "request_nonce": str(request_nonce),
                "operation": {"kind": "provider_encounter"},
            },
            key,
            _negotiated=current,
        )
        return mount, review

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

    async def prepare_and_authorize_source(
        self,
        mount: CoreProviderMount,
        body: Mapping[str, object],
        key: str,
    ) -> dict[str, object]:
        """One Core request composes two existing decisions with distinct intents.

        The native owner must journal its original stop proof before dispatch.
        No automatic retry or persistent context is created by this sequence.
        """
        _checked(mount, CoreProviderMount)
        payload = _snapshot(body, 8192)
        authorize_key = payload.pop("authorize_idempotency_key", None)
        authorize_nonce = _uuid(payload.pop("authorize_request_nonce", None))
        for value in (key, authorize_key):
            _require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", _checked(value, str)))
        _require(key != authorize_key and payload.get("request_nonce") != authorize_nonce)
        _validate_intent(mount, "capture-operations", payload, native_start=True)
        operation = _object(payload["operation"])
        _require(operation["action"] == "prepare")
        intent = SourceStartIntent.model_validate(operation["payload"])
        sequence = {
            **payload,
            "operation": {
                "kind": "source_start_sequence",
                "payload": operation["payload"],
                "authorize_idempotency_key": authorize_key,
            },
        }
        current = await self._negotiate(mount.selection, capture_mount=mount)
        combined = await self._dispatch(
            mount,
            "capture-operations",
            sequence,
            key,
            current,
        )
        _require(
            set(combined)
            == _SCOPE_KEYS
            | {
                "contract_version",
                "checked_at",
                "operation",
                "receipt",
            }
        )
        pair = _object(combined.get("receipt"))
        _require(set(pair) == {"preparation", "authorization"})
        try:
            receipt = SourceStartReceipt.model_validate(pair["preparation"])
            decision = SourceStartCapability.model_validate(pair["authorization"])
        except ValueError:
            raise ProviderCoreUnavailable() from None
        issued = decision.receipt
        now = self._clock()
        _require(
            receipt.state == "prepared"
            and receipt.creator_actor_id == mount.selection.actor_ref
            and receipt.issued_at is None
            and receipt.expires_at is None
            and now < receipt.preparation_expires_at <= intent.capture_authorized_until
            and all(
                getattr(receipt, field) == getattr(intent, field)
                for field in (
                    "attempt_id",
                    "source",
                    "lease_id",
                    "lease_receipt_id",
                    "lease_generation",
                    "capture_authorized_until",
                    "first_sequence_number",
                )
            )
            and receipt.model_dump(exclude={"state", "issued_at", "expires_at"})
            == issued.model_dump(exclude={"state", "issued_at", "expires_at"})
            and issued.state == "issued"
            and issued.issued_at is not None
            and issued.expires_at is not None
            and issued.issued_at <= now + timedelta(seconds=5)
            and issued.issued_at < issued.preparation_expires_at
            and now < issued.expires_at <= issued.capture_authorized_until
            and timedelta(0) < issued.expires_at - issued.issued_at <= timedelta(seconds=15)
            and len(decision.secret.get_secret_value()) == 64
            and hmac.compare_digest(
                decision.secret.get_secret_value().encode("utf-8"),
                intent.owner_proof.get_secret_value().encode("ascii"),
            )
        )
        # Core owns cancellation between its decisions. An ambiguous reply still
        # leaves stop custody with the native owner; never fall back or retry.
        await asyncio.sleep(0)
        envelope = {**combined, "operation": "source_start"}
        return {
            "preparation": {**envelope, "receipt": pair["preparation"]},
            "authorization": {
                **envelope,
                "request_nonce": authorize_nonce,
                "receipt": pair["authorization"],
            },
        }

    async def open_note(
        self, mount: CoreProviderMount, session_id: UUID, request_nonce: UUID, key: str
    ) -> dict[str, object]:
        """Fresh review/templates/existing note with one request-local negotiation.

        Never generate/save a note or retain credentials for another action. Each
        Core read still rechecks current access before and after its own I/O.
        """
        _checked(mount, CoreProviderMount)
        _checked(session_id, UUID)
        _checked(request_nonce, UUID)
        _require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", _checked(key, str)))
        try:
            async with asyncio.timeout(NOTE_OPENING_TOTAL_TIMEOUT_SECONDS):
                return await self._open_note(mount, session_id, request_nonce, key)
        except TimeoutError:
            raise ProviderCoreUnavailable("core_provider_request_timeout") from None

    async def _open_note(
        self, mount: CoreProviderMount, session_id: UUID, request_nonce: UUID, key: str
    ) -> dict[str, object]:
        current = await self._negotiate(mount.selection)
        _require(current.mount == mount)
        scope = {
            "workspace_id": str(mount.selection.workspace_id),
            "binding_ref": mount.binding_ref,
        }

        async def read(action: str, payload: dict[str, object], phase: str) -> dict[str, object]:
            # Separate deterministic keys even for templates/read on the same
            # Core route; never alias distinct intents under one idempotency key.
            value = await self._request(
                mount,
                _ROOT + action,
                {
                    **scope,
                    "request_nonce": str(uuid5(request_nonce, phase)),
                    **payload,
                },
                str(uuid5(request_nonce, key + ":" + phase)),
                _negotiated=current,
            )
            receipt = _object(value.get("receipt"))
            _require(receipt.get("session_id") == str(session_id))
            return receipt

        review = await read(
            "capture-operations", {"operation": {"kind": "creator_review"}}, "review"
        )
        _require(review.get("schema_version") == "1.0")
        working = review.get("working")
        templates: list[object] | None = None
        note: dict[str, object] | None = None
        if (
            review.get("status") == "transcript_ready"
            and isinstance(working, dict)
            and cast(dict[str, object], working).get("note_ready") is True
        ):
            source = _note_source(review)
            available = await read(
                "capture-notes",
                {
                    "expected_session_id": str(session_id),
                    "action": "templates",
                },
                "templates",
            )
            _require(set(available) == {"session_id", "templates"})
            _require(isinstance(available["templates"], list))
            templates = cast(list[object], available["templates"])
            _require(len(templates) <= 100)
            if len(templates) == 1:
                schema = _object(templates[0]).get("schema_ref")
                _require(_reference(schema, "doctor_note_schema"))
                note = await read(
                    "capture-notes",
                    {
                        "expected_session_id": str(session_id),
                        "action": "read",
                        "schema_ref": schema,
                    },
                    "note",
                )
                _require(note.get("schema_ref") == schema and note.get("reviewed_source") == source)
        receipt: dict[str, object] = {
            "session_id": str(session_id),
            "review": review,
            "templates": templates,
            "note": note,
        }
        result: dict[str, object] = {
            "contract_version": "1",
            **scope,
            "request_nonce": str(request_nonce),
            "checked_at": self._clock().isoformat(),
            "operation": "note_opening",
            "receipt": receipt,
        }
        # Keep the existing native review byte budget. An oversized combination
        # explicitly selects separately bounded legacy reads; never truncate it.
        if (
            len(
                json.dumps(
                    result, ensure_ascii=False, allow_nan=False, separators=(",", ":")
                ).encode("utf-8")
            )
            > MAX_CORE_CAPTURE_RESPONSE_BYTES
        ):
            result["receipt"] = {"session_id": str(session_id), "separate_reads_required": True}
        return result

    async def _request(
        self,
        mount: CoreProviderMount,
        path: str,
        body: Mapping[str, object],
        key: str,
        *,
        native_start: bool = False,
        _negotiated: _NegotiatedMount | None = None,
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
        if _negotiated is not None:
            _require(not native_start and _negotiated_read(action, payload))
        current = _negotiated or await self._negotiate(
            mount.selection,
            capture_mount=mount if action == "capture-operations" else None,
        )
        return await self._dispatch(mount, action, payload, key, current)

    async def _dispatch(
        self,
        mount: CoreProviderMount,
        action: str,
        payload: dict[str, object],
        key: str,
        current: _NegotiatedMount,
    ) -> dict[str, object]:
        # Callers validate complete intents before reaching this helper. A
        # combined native start shares negotiation only within its one request;
        # _send checks current access around I/O; Core checks each decision.
        _require(current.mount == mount)
        headers = {
            **(current.opening.headers() if current.opening else await self._workload_headers()),
            **current.headers(),
        }
        headers["Idempotency-Key"] = key
        # Credentials remain request-local even when this connection is used
        # concurrently for progress reads and an explicit provider action.
        try:
            value, _ = await self._send(
                mount.selection,
                _ROOT + action,
                payload,
                headers,
                version=("X-Cosmaneura-Capture-Version", "1"),
                max_bytes=MAX_CORE_CAPTURE_RESPONSE_BYTES
                if action == "capture-operations"
                else 8 * 1024 * 1024,
                opening=current.opening,
                request_timeout=ADMISSION_CORE_TIMEOUT_SECONDS
                if action == "capture-admissions"
                else 100
                if action == "capture-notes" and payload.get("action") == "prepare"
                else 20,
            )
        finally:
            if current.opening:
                current.opening.close()
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
        with provider_phase_timing("workload_token"):
            try:
                async with asyncio.timeout(10):
                    value = await self._workload_token()
                return {"Authorization": "Bearer " + _secret(value)}
            except Exception:
                raise ProviderCoreUnavailable("core_provider_workload_unavailable") from None

    async def _negotiate(
        self,
        expected: CoreProviderSelection | None,
        *,
        capture_mount: CoreProviderMount | None = None,
        opening: bool = False,
    ) -> _NegotiatedMount:
        _require(not opening or capture_mount is None and expected is None)
        # Opening and capture operations both dispatch a fixed sequence. Reuse
        # only adjacent post/pre-I/O checks within this invocation; receiver
        # selection/publication and all later requests still check afresh.
        sequence = _OpeningSequence() if opening or capture_mount is not None else None
        if capture_mount is not None:
            _checked(capture_mount, CoreProviderMount)
            _require(
                capture_mount.selection == expected
                and _reference(capture_mount.binding_ref, "scribe_capture_binding")
            )
        context = await self._context(expected)
        selection = context.selection
        issued, _ = await self._send_in_context(
            context,
            "/embed/v1/context-tokens/exchange",
            {"requested_surface": "provider_assistant", "record_ref": selection.appointment_ref},
            {
                "Authorization": "Bearer " + _secret(context.user_token),
                "X-Cosmaneura-Embed-Version": "1.0",
            },
            status=201,
            version=("X-Cosmaneura-Embed-Version", "1.0"),
            opening=sequence,
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
                **(sequence.headers() if sequence else await self._workload_headers()),
                "X-Cosmaneura-Mount-Context": _secret(token),
                "X-Cosmaneura-Client-Turn-ID": str(turn),
            },
            opening=sequence,
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
        if capture_mount is not None:
            # Capture operations authorize this exact binding in Core before
            # any downstream work, then recheck it before publishing. Reuse the
            # identifier only; token/interaction and registry checks stay fresh
            # for every request. Opening, admission and notes still resolve it.
            return _NegotiatedMount(capture_mount, token, interaction, turn, sequence)
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
            {**(sequence.headers() if sequence else await self._workload_headers()), **headers},
            version=("X-Cosmaneura-Capture-Version", "1"),
            opening=sequence,
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
            sequence,
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
        opening: _OpeningSequence | None = None,
    ) -> tuple[dict[str, object], httpx.Headers]:
        context = opening.take() if opening else await self._context(selection)
        _require(context.selection == selection)
        return await self._send_in_context(
            context,
            path,
            payload,
            headers,
            status=status,
            version=version,
            max_bytes=max_bytes,
            request_timeout=request_timeout,
            opening=opening,
        )

    async def _send_in_context(
        self,
        context: AuthorizedCoreProvider,
        path: str,
        payload: object,
        headers: Mapping[str, str],
        *,
        status: int = 200,
        version: tuple[str, str] | None = None,
        max_bytes: int = 16_384,
        request_timeout: float = 20,
        opening: _OpeningSequence | None = None,
    ) -> tuple[dict[str, object], httpx.Headers]:
        # Context was checked immediately before dispatch, or consumed from
        # the adjacent opening post-I/O check without an intervening await.
        # Exchange needs that same context for its user-token header. Never
        # retain it across requests; publication still checks access again.
        _require(self._enabled)
        selection = context.selection
        try:
            phase = {
                "/embed/v1/context-tokens/exchange": "core_exchange",
                "/service/v1/agent/mount-context/resolve": "core_mount",
                _ROOT + "capture-bindings/resolve": "core_binding",
            }.get(path, "core_operation")
            with provider_phase_timing(phase):
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
            if opening is not None:
                _require(not opening.closed and opening.context is None)
                if opening.workload_headers is None:
                    _require(path == "/embed/v1/context-tokens/exchange")
                    # Credential retrieval can yield or change access. Finish it
                    # before the post-exchange check shared with mount dispatch.
                    opening.workload_headers = await self._workload_headers()
                opening.context = await self._context(selection)
            else:
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


def _negotiated_read(action: str, body: dict[str, object]) -> bool:
    keys = set(body) - _SCOPE_KEYS
    if action == "capture-operations":
        return keys == {"operation"} and body.get("operation") in (
            {"kind": "provider_encounter"},
            {"kind": "creator_review"},
        )
    if action != "capture-notes":
        return False
    return (
        body.get("action") == "templates"
        and keys == {"expected_session_id", "action"}
        or body.get("action") == "read"
        and keys == {"expected_session_id", "action", "schema_ref"}
        and _reference(body.get("schema_ref"), "doctor_note_schema")
    )


def _note_source(review: dict[str, object]) -> dict[str, object]:
    source, working = _object(review.get("source")), _object(review.get("working"))
    source_version = source.get("source_transcript_version")
    working_version = working.get("working_transcript_version")
    _require(type(source_version) is int and source_version > 0)
    _require(type(working_version) is int and working_version > 0)
    result: dict[str, object] = {
        "kind": "reviewed_english",
        "source_version": source_version,
        "working_transcript_id": _uuid(working.get("working_transcript_id")),
        "working_version": working_version,
    }
    if "capture_continuity" in review:
        result["capture_continuity"] = review["capture_continuity"]
    return result


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
        if operation["kind"] == "native_recording_context":
            _require(set(operation) == {"kind"})
    else:
        _require(keys <= {"expected_session_id", "schema_ref", "action", "edit"})
        _uuid(body.get("expected_session_id"))
        _require(
            body.get("action") in ("templates", "read", "prepare", "save", "resolve", "save_status")
        )


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


# The native read facade shares these exact closed wire validators.
core_wire_object = _object
core_wire_require = _require
core_wire_secret = _secret
core_wire_snapshot = _snapshot
core_wire_uuid = _uuid
