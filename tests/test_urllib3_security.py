"""Network-free regressions for the transport dependency security update."""

import subprocess
import sys
from textwrap import dedent

import pytest


@pytest.mark.parametrize("mode", ["deflate", "chunk-line"])
def test_chunked_responses_terminate_and_enforce_resource_bounds(mode):
    # A subprocess deadline turns the old decoder's infinite loop into a bounded
    # failure instead of hanging the entire test process.
    script = dedent(
        """
        import http.client
        import io
        import sys
        import zlib

        from urllib3.exceptions import ProtocolError
        from urllib3.response import HTTPResponse

        mode = sys.argv[1]
        payload = b"synthetic transport fixture " * 1024
        if mode == "deflate":
            compressed = zlib.compress(payload) + b"trailing-bytes"
            chunks = f"{len(compressed):x}\\r\\n".encode() + compressed + b"\\r\\n0\\r\\n\\r\\n"
        else:
            chunks = b"1;" + b"x" * 65536 + b"\\r\\nx\\r\\n0\\r\\n\\r\\n"
        wire = (b"HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\n"
                b"Content-Encoding: deflate\\r\\n\\r\\n" + chunks)

        class Socket:
            def makefile(self, *args, **kwargs):
                return io.BytesIO(wire)

        raw = http.client.HTTPResponse(Socket(), method="GET")
        raw.begin()
        response = HTTPResponse(body=raw, headers=dict(raw.getheaders()),
                                original_response=raw, preload_content=False)
        if mode == "deflate":
            decoded = b"".join(response.stream(4096, decode_content=True))
            assert decoded == payload, (len(decoded), len(payload), decoded[-32:])
        else:
            try:
                list(response.read_chunked(17))
            except ProtocolError as error:
                assert "maximum allowed length" in str(error)
                assert response.closed
            else:
                raise AssertionError("oversized chunk-size line was accepted")
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script, mode],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_https_proxy_keeps_its_own_tls_policy(monkeypatch):
    import ssl
    from types import SimpleNamespace
    from unittest.mock import Mock, sentinel

    from urllib3 import connection
    from urllib3._base_connection import ProxyConfig

    proxy_context = ssl.create_default_context()
    destination_context = ssl.create_default_context()
    wrap = Mock(return_value=SimpleNamespace(socket=sentinel.secured, is_verified=True))
    monkeypatch.setattr(connection, "_ssl_wrap_socket_and_match_hostname", wrap)
    client = connection.HTTPSConnection(
        "destination.example.invalid",
        ssl_context=destination_context,
        cert_reqs=ssl.CERT_NONE,
        assert_hostname="destination.example.invalid",
        assert_fingerprint="destination-fingerprint",
        cert_file="destination-client.pem",
        proxy_config=ProxyConfig(proxy_context, True, "proxy.example.invalid", "proxy-fingerprint"),
    )
    assert client._connect_tls_proxy("proxy.example.invalid", sentinel.socket) is sentinel.secured
    assert wrap.call_args.kwargs["ssl_context"] is proxy_context
    assert wrap.call_args.kwargs["cert_reqs"] == proxy_context.verify_mode
    assert wrap.call_args.kwargs["assert_hostname"] == "proxy.example.invalid"
    assert wrap.call_args.kwargs["assert_fingerprint"] == "proxy-fingerprint"
    assert wrap.call_args.kwargs["cert_file"] is None
    assert client.proxy_is_verified is True
