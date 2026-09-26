"""Reuse Core TCP/TLS connections without retaining provider authorization."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import httpx


class ProviderCoreConnections:
    """Owned by one receiver runtime/event loop, closed at runtime shutdown.

    Each operation still owns a separate AsyncClient, cookie policy and fresh
    authorization. Only the underlying bounded HTTP connection pool is shared.
    """

    def __init__(self, origin: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        url = httpx.URL(origin)
        if (
            url.scheme != "https"
            or not url.host
            or url.userinfo
            or url.path != "/"
            or url.query
            or url.fragment
        ):
            raise ValueError("core_connection_origin_invalid")
        self._origin = (url.scheme, url.host, url.port)
        self._loop = asyncio.get_running_loop()
        self._closed = False
        self._transport = transport or httpx.AsyncHTTPTransport(
            trust_env=False,
            retries=0,
            limits=httpx.Limits(
                max_connections=8, max_keepalive_connections=4, keepalive_expiry=30
            ),
        )

    def borrow(self, origin: str) -> httpx.AsyncBaseTransport:
        self._current()
        url = httpx.URL(origin)
        if (url.scheme, url.host, url.port) != self._origin:
            raise RuntimeError("core_connection_origin_changed")
        return _BorrowedCoreConnections(self._send)

    async def close(self) -> None:
        if self._closed:
            return
        self._current()
        self._closed = True
        await self._transport.aclose()

    def _current(self) -> None:
        if self._closed or asyncio.get_running_loop() is not self._loop:
            raise RuntimeError("core_connections_unavailable")

    async def _send(self, request: httpx.Request) -> httpx.Response:
        self._current()
        if (request.url.scheme, request.url.host, request.url.port) != self._origin:
            raise RuntimeError("core_connection_origin_changed")
        return await self._transport.handle_async_request(request)


class _BorrowedCoreConnections(httpx.AsyncBaseTransport):
    def __init__(self, send: Callable[[httpx.Request], Awaitable[httpx.Response]]) -> None:
        self._send = send
        self._closed = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._closed:
            raise RuntimeError("core_connections_unavailable")
        return await self._send(request)

    async def aclose(self) -> None:
        # Closing one operation must not close another operation's connection.
        self._closed = True
