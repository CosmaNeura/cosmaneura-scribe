"""Fixed standalone receiver entry; no argv/env-selected backend or configuration."""

from pathlib import Path

import uvicorn
from cosmaneura_scribe.safe_logging import configure_private_api_acceptance_logging
from receiver_runtime import ReceiverService


def main() -> None:
    configure_private_api_acceptance_logging()
    uvicorn.run(
        ReceiverService(Path("/app/provider-config/receiver.json")),
        host="0.0.0.0",
        port=8080,
        proxy_headers=False,
        forwarded_allow_ips="",
        access_log=False,
        log_level="warning",
        log_config=None,
        server_header=False,
    )


if __name__ == "__main__":
    main()
