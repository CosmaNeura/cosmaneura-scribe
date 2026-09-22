"""Prepare an owned, private W13 read-only connection trial; never start services."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

FILES = (
    "__init__.py",
    "config.py",
    "db.py",
    "models.py",
    "api/__init__.py",
    "api/auth.py",
    "application/__init__.py",
    "application/workspace.py",
    "domain/__init__.py",
    "domain/enums.py",
    "domain/hashing.py",
    "domain/work_lanes.py",
)


def prepare(root: Path, source: Path, address: str, subject: str) -> None:
    ip = ipaddress.IPv4Address(address)
    if not any(
        ip in ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    ):
        raise ValueError("A private LAN address is required")
    if not re.fullmatch(r"user_[A-Za-z0-9]{10,100}", subject) or any(root.iterdir()):
        raise ValueError("Reviewed Tester subject and an empty owned directory are required")
    root.chmod(0o700)
    manifest = {}
    for relative in FILES:
        contents = (source / "src/cosmas_os" / relative).read_bytes()
        target = root / "server-source/cosmas_os" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
        manifest[relative] = hashlib.sha256(contents).hexdigest()
    for name in ("server.py", "seed.py"):
        shutil.copyfile(Path(__file__).with_name(name), root / name)
    (root / "socket").mkdir(mode=0o700)
    (root / "tls").mkdir(mode=0o700)
    now = datetime.now(UTC)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "W13 owned connection trial")])
    ca = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=7))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(False, False, False, False, False, True, True, False, False),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, address)]))
        .issuer_name(ca_name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=7))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip)]), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.KeyUsage(True, False, True, False, False, False, False, False, False),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    # The CA signing key is discarded; only this exact seven-day leaf is usable.
    (root / "tls/ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (root / "tls/ca.der").write_bytes(ca.public_bytes(serialization.Encoding.DER))
    (root / "tls/server.pem").write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    key_path = root / "tls/server-key.pem"
    descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(
            leaf_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
    config = {
        "purpose": "W13 private synthetic read-only encounter connection",
        "root": str(root),
        "address": address,
        "port": 8446,
        "api_origin": f"https://{address}:8446",
        "database": "w13_connection_test",
        "database_port": 55462,
        "issuer": "https://sharp-bluegill-3253.clerk.accounts.dev",
        "audience": "cosmas-os-beta-api",
        "organization": "org_3IonFhWeRdI0H9nOPcuyXiqqbmv",
        "subject": subject,
        "box": str(uuid4()),
        "actor": str(uuid4()),
        "ca_der_sha256": hashlib.sha256(ca.public_bytes(serialization.Encoding.DER)).hexdigest(),
        "leaf_der_sha256": hashlib.sha256(
            leaf.public_bytes(serialization.Encoding.DER)
        ).hexdigest(),
        "expires_at": leaf.not_valid_after_utc.isoformat(),
        "source_sha256": manifest,
    }
    (root / "runtime.json").write_text(json.dumps(config, indent=2) + "\n")
    print(
        "Prepared private endpoint, seven-day certificate and frozen receiver inputs; "
        "no service started."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--address", required=True)
    parser.add_argument("--tester-subject", required=True)
    args = parser.parse_args()
    prepare(args.root.resolve(), args.source.resolve(), args.address, args.tester_subject)
