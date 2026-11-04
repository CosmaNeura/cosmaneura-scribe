"""Closed account setup signal, accepted only from checked Core responses."""

from typing import Literal
from uuid import UUID

from .provider_core_transport import ProviderCoreUnavailable, core_wire_require


class ProviderAccountSetupRequired(ProviderCoreUnavailable):
    def __init__(self, setup: Literal["practice", "activation"], request_nonce: str):
        super().__init__("scribe_account_setup_required", 409)
        self.setup = setup
        self.request_nonce = request_nonce

    def body(self, revision: str) -> dict[str, object]:
        return {
            "type": "scribe_account_setup_required",
            "status": 409,
            "setup": self.setup,
            "request_nonce": self.request_nonce,
            "revision": revision,
        }


def checked_setup(value: dict[str, object], nonce: str) -> ProviderAccountSetupRequired:
    core_wire_require(
        set(value) == {"type", "status", "setup", "request_nonce"}
        and value.get("type") == "scribe_account_setup_required"
        and type(value.get("status")) is int
        and value.get("status") == 409
        and value.get("request_nonce") == nonce
        and str(UUID(nonce)) == nonce
        and UUID(nonce).int != 0
    )
    setup = value.get("setup")
    core_wire_require(setup in {"practice", "activation"})
    assert setup == "practice" or setup == "activation"
    return ProviderAccountSetupRequired("practice" if setup == "practice" else "activation", nonce)
