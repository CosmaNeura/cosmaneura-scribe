"""Offline pool lifecycle and real local TLS keep-alive; no external service."""

import asyncio
import contextlib
import ssl
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from cosmaneura_scribe.provider_core_connections import ProviderCoreConnections
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

pytestmark = pytest.mark.asyncio


class TrackedTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self.closed = 0
        self.calls = []
        self.fail = False

    async def handle_async_request(self, request):
        self.calls.append(request)
        if self.fail:
            raise httpx.ReadError("offline_lost_response")
        return httpx.Response(200, json={"ok": True})

    async def aclose(self):
        self.closed += 1


async def test_operation_close_retains_pool_until_runtime_shutdown():
    wire = TrackedTransport()
    pool = ProviderCoreConnections("https://core.synthetic.invalid", transport=wire)
    first = pool.borrow("https://core.synthetic.invalid")
    second = pool.borrow("https://core.synthetic.invalid")
    async with httpx.AsyncClient(transport=first) as client:
        await client.get("https://core.synthetic.invalid/first")
    assert wire.closed == 0
    async with httpx.AsyncClient(transport=second) as client:
        await client.get("https://core.synthetic.invalid/second")
    assert wire.closed == 0 and len(wire.calls) == 2
    with pytest.raises(RuntimeError, match="core_connections_unavailable"):
        await first.handle_async_request(httpx.Request("GET", "https://core.synthetic.invalid"))
    retained = pool.borrow("https://core.synthetic.invalid")
    await pool.close()
    await pool.close()
    assert wire.closed == 1
    with pytest.raises(RuntimeError, match="core_connections_unavailable"):
        await retained.handle_async_request(httpx.Request("GET", "https://core.synthetic.invalid"))
    with pytest.raises(RuntimeError, match="core_connections_unavailable"):
        pool.borrow("https://core.synthetic.invalid")


async def test_pool_never_retries_uncertain_operations_or_accepts_other_origins():
    wire = TrackedTransport()
    pool = ProviderCoreConnections("https://core.synthetic.invalid", transport=wire)
    try:
        wire.fail = True
        async with httpx.AsyncClient(
            transport=pool.borrow("https://core.synthetic.invalid")
        ) as client:
            with pytest.raises(httpx.ReadError):
                await client.post("https://core.synthetic.invalid/mutation")
            assert len(wire.calls) == 1
            with pytest.raises(RuntimeError, match="core_connection_origin_changed"):
                await client.get("https://other.synthetic.invalid/")
            with pytest.raises(RuntimeError, match="core_connection_origin_changed"):
                pool.borrow("https://other.synthetic.invalid")
            assert len(wire.calls) == 1
    finally:
        await pool.close()


async def test_pool_rejects_a_different_event_loop():
    pool = ProviderCoreConnections("https://core.synthetic.invalid", transport=TrackedTransport())

    async def other_loop():
        with pytest.raises(RuntimeError, match="core_connections_unavailable"):
            pool.borrow("https://core.synthetic.invalid")

    try:
        await asyncio.to_thread(lambda: asyncio.run(other_loop()))
    finally:
        await pool.close()


@pytest.mark.parametrize(
    "origin",
    [
        "http://core.synthetic.invalid",
        "https://user:secret@core.synthetic.invalid",
        "https://core.synthetic.invalid/path",
        "https://core.synthetic.invalid?query=x",
        "https://core.synthetic.invalid#fragment",
    ],
)
async def test_invalid_pool_origin_is_refused(origin):
    with pytest.raises(ValueError, match="core_connection_origin_invalid"):
        ProviderCoreConnections(origin, transport=TrackedTransport())


async def test_separate_operations_reuse_one_verified_tls_connection(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(hours=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    certificate, private_key = tmp_path / "certificate.pem", tmp_path / "key.pem"
    certificate.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    private_key.touch(mode=0o600)
    private_key.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_tls.load_cert_chain(certificate, private_key)
    client_tls = ssl.create_default_context(cafile=str(certificate))
    connections, headers, finished = [], [], []

    async def serve(reader, writer):
        connections.append(writer)
        closed = asyncio.Event()
        finished.append(closed)
        try:
            while True:
                request = await reader.readuntil(b"\r\n\r\n")
                headers.append(request.lower())
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}"
                )
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()
            closed.set()

    server = await asyncio.start_server(serve, "127.0.0.1", 0, ssl=server_tls)
    origin = f"https://localhost:{server.sockets[0].getsockname()[1]}"
    pool = ProviderCoreConnections(
        origin, transport=httpx.AsyncHTTPTransport(verify=client_tls, trust_env=False, retries=0)
    )
    try:
        async with asyncio.timeout(10):
            # The old per-operation transport performs a new TLS handshake for
            # every client, even when the same Core origin is used immediately.
            for _ in range(3):
                async with httpx.AsyncClient(verify=client_tls, trust_env=False) as client:
                    assert (await client.get(origin + "/")).status_code == 200
            assert len(connections) == 3
            headers.clear()
            # Each operation closes its own actual client. Both clients use
            # explicit request-local headers and the same authenticated socket.
            for actor in ["offline-a", "offline-b", "offline-c"]:
                async with httpx.AsyncClient(
                    transport=pool.borrow(origin), trust_env=False
                ) as client:
                    response = await client.get(
                        origin + "/", headers={"Authorization": "Bearer " + actor}
                    )
                    assert response.status_code == 200
            assert len(connections) == 4 and len(headers) == 3
            for actor, request in zip(
                [b"offline-a", b"offline-b", b"offline-c"], headers, strict=True
            ):
                assert b"authorization: bearer " + actor + b"\r\n" in request
                assert request.count(b"authorization:") == 1 and b"cookie:" not in request
    finally:
        await pool.close()
        server.close()
        await server.wait_closed()
        async with asyncio.timeout(5):
            await asyncio.gather(*(event.wait() for event in finished))
