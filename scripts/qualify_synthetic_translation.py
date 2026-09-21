"""Call the existing CosmasCode GPT-4.1 deployment with eight fixed invented cases.

No input file, arbitrary endpoint, patient content, model switch or API key is
accepted. Authentication uses the operator's existing Azure CLI session. Output
contains only opaque case IDs, agreement states and bounded failure codes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import httpx
from azure.identity.aio import AzureCliCredential
from cosmaneura_scribe.azure_translation import (
    AzureGPT41TranslationAdapter,
    AzureTranslationProfile,
)
from cosmaneura_scribe.translation_fidelity import SYNTHETIC_CASES, qualify_synthetic_translation

_ENDPOINT = "https://cosmascode.services.ai.azure.com/openai/v1"
_DEPLOYMENT = "gpt-4.1"


class _SelectedSyntheticEndpoint:
    """Only this fixed non-PHI probe permits the selected public model endpoint.

The clinical runtime must supply its approved private endpoint guard instead.
No application route imports or constructs this guard.
"""

    def __init__(self, profile: AzureTranslationProfile) -> None:
        self.profile = profile

    async def verify(self) -> None:
        if self.profile.endpoint != _ENDPOINT or self.profile.deployment != _DEPLOYMENT:
            raise ValueError("synthetic_translation_target_invalid")


class _StatusOnlyTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.inner: httpx.AsyncHTTPTransport | None = None
        self.statuses: list[int] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # The adapter closes its client after each one-shot request. Give the
        # next fixed case a fresh pool, never a previously closed transport.
        if self.inner is None:
            self.inner = httpx.AsyncHTTPTransport(retries=0, trust_env=False)
        response = await self.inner.handle_async_request(request)
        self.statuses.append(response.status_code)
        return response

    async def aclose(self) -> None:
        if self.inner is not None:
            await self.inner.aclose()
            self.inner = None


async def run(case_id: str | None) -> dict[str, object]:
    profile = AzureTranslationProfile(_ENDPOINT, _DEPLOYMENT)
    transport = _StatusOnlyTransport()
    async with AzureCliCredential(process_timeout=20) as credential:
        adapter = AzureGPT41TranslationAdapter(
            profile, credential=credential, endpoint_guard=_SelectedSyntheticEndpoint(profile),
            transport=transport,
        )
        result = await qualify_synthetic_translation(adapter, case_id=case_id)
    result["http_statuses"] = transport.statuses
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--approve-fixed-synthetic-cases", action="store_true", required=True)
    parser.add_argument("--case-id", choices=[case.case_id for case in SYNTHETIC_CASES])
    args = parser.parse_args()
    if args.output.exists() or not args.output.parent.is_dir():
        parser.error("output must be a new file in an existing directory")
    try:
        result = asyncio.run(run(args.case_id))
        with args.output.open("x", encoding="utf-8") as output:
            output.write(json.dumps(result, indent=2, sort_keys=True) + "\n")
        print(json.dumps(result, sort_keys=True))
        return 0 if result["reference_agreement_count"] == result["planned_case_count"] else 1
    except Exception:
        print('{"result":"qualification_failed"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
