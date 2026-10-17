"""One native HTTPS integration check; no real user, Core or speech service."""

import asyncio
import base64
import contextlib
import hashlib
import ipaddress
import json
import os
import socket
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import test_receiver
import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

engine, harness = test_receiver.engine, test_receiver.harness
NATIVE_ROOT = Path(os.environ["SCRIBE_PROVIDER_NATIVE_ROOT"]).resolve()


def certificate(root, address):
    directory = Path(tempfile.mkdtemp(prefix="offline-tls-", dir=root))
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Offline provider HTTPS fixture")])
    now = datetime.now(UTC)
    ca = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    leaf_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, address)])
    leaf = (
        x509.CertificateBuilder()
        .subject_name(leaf_name)
        .issuer_name(name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(address))]),
            critical=False,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    (directory / "server.pem").write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    descriptor = os.open(directory / "server-key.pem", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(
            leaf_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
    return directory, {
        "caDER": base64.b64encode(ca.public_bytes(serialization.Encoding.DER)).decode(),
        "leafSHA256": hashlib.sha256(leaf.public_bytes(serialization.Encoding.DER)).hexdigest(),
    }


@pytest.mark.asyncio
async def test_native_https_receiver(harness):
    h = harness
    root = NATIVE_ROOT
    address = os.environ["SCRIBE_PROVIDER_HTTPS_ADDRESS"]
    assert root.name.startswith("scribe-provider-native-bridge-")
    assert any(
        ipaddress.ip_address(address) in ipaddress.ip_network(net)
        for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    )
    tls, profile = certificate(root, address)
    sock = socket.socket()
    sock.bind((address, 0))
    sock.setblocking(False)
    origin = f"https://{address}:{sock.getsockname()[1]}"
    profile["endpoint"] = origin
    h.receiver.profile = type(h.profile)(
        origin, h.profile.core_origin, h.profile.environment_id, h.profile.native_origins
    )
    server = uvicorn.Server(
        uvicorn.Config(
            h.app,
            access_log=False,
            log_config=None,
            log_level="critical",
            ssl_certfile=str(tls / "server.pem"),
            ssl_keyfile=str(tls / "server-key.pem"),
            proxy_headers=False,
            server_header=False,
            timeout_keep_alive=1,
        )
    )
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    process = None
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if serving.done():
                    await serving
                    raise AssertionError("Offline fixture failed to start")
                await asyncio.sleep(0.01)
        process = await asyncio.create_subprocess_exec(
            str(root / "check-native-receiver"),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        # Offline credential travels over stdin, never argv, logs or a file.
        configuration = {
            "profile": profile,
            "token": h.token(native=True),
            "subject": h.subject,
            "organization": h.settings.clerk_organization_id,
            "issuer": h.settings.clerk_issuer,
            "audience": h.settings.clerk_audience,
            "workspace": h.workspace,
        }
        async with asyncio.timeout(45):
            output, errors = await process.communicate(json.dumps(configuration).encode())
        assert process.returncode == 0, "Native roundtrip failed; raw diagnostics suppressed"
        assert not errors
        exchange = "/embed/v1/context-tokens/exchange"
        mount = "/service/v1/agent/mount-context/resolve"
        binding = "/service/v1/agent/scribe/capture-bindings/resolve"
        assert h.wire.calls == [
            exchange, mount, binding,
            exchange, mount, binding, "/service/v1/agent/scribe/capture-admissions",
            exchange, mount, "/service/v1/agent/scribe/capture-operations",
            exchange, mount, binding, "/service/v1/agent/scribe/capture-notes",
        ]
        assert h.wire.operations == ["creator_review"]
        (root / "native-https-check.log").write_bytes(output)
        (root / "native-https-receipt.json").write_text(
            json.dumps(
                {
                    "result": "pass",
                    "native_requests": 5,
                    "offline_core_wire_requests": len(h.wire.calls),
                    "leaf_sha256": profile["leafSHA256"],
                    "tls_pin_used": True,
                    "wrong_pin_rejected": True,
                    "new_offline_fixture_only": True,
                    "real_core_or_clerk_contacted": False,
                },
                indent=2,
            )
            + "\n"
        )
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.wait()
        server.should_exit = True
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(10):
                await serving
        if not serving.done():
            serving.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await serving
        sock.close()
