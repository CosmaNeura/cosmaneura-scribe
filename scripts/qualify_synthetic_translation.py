"""Call the existing CosmasCode GPT-4.1 deployment with eight fixed invented cases.

No input file, arbitrary endpoint, patient content, model switch or API key is
accepted. Authentication uses the operator's existing Azure CLI session. Output
contains only opaque case IDs, agreement states and bounded failure codes.
Error diagnostics use fixed allowlisted codes/flags, never provider messages,
request headers, response text or arbitrary returned values.
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
_MAX_ERROR_BYTES = 16_384
_ERROR_CODES = frozenset({
    "content_filter", "ResponsibleAIPolicyViolation", "invalid_request_error",
    "InvalidRequest", "context_length_exceeded", "DeploymentNotFound",
    "OperationNotSupported", "Unauthorized", "PermissionDenied", "RateLimitExceeded",
})
_FILTER_CATEGORIES = ("hate", "self_harm", "sexual", "violence", "jailbreak", "indirect_attack")


def _unique_error_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_error_key")
        result[key] = value
    return result


def _error_metadata(raw: bytes) -> dict[str, object]:
    if len(raw) > _MAX_ERROR_BYTES:
        return {"diagnostic": "body_limit"}
    try:
        body = json.loads(raw, object_pairs_hook=_unique_error_object)
        if not isinstance(body, dict) or not isinstance(body.get("error"), dict):
            raise ValueError("error_object_missing")
        error = body["error"]
        inner = error.get("innererror")
        if not isinstance(inner, dict):
            inner = {}
        result: dict[str, object] = {"diagnostic": "parsed"}
        for output_key, value in (("error_code", error.get("code")),
                                  ("inner_code", inner.get("code"))):
            result[output_key] = (
                value if isinstance(value, str) and value in _ERROR_CODES else "other_or_absent"
            )
        filters = inner.get("content_filter_result")
        if not isinstance(filters, dict):
            filters = {}
        result["filter_flags"] = [
            f"{category}_{flag}"
            for category in _FILTER_CATEGORIES
            for flag in ("detected", "filtered")
            if isinstance(filters.get(category), dict)
            and filters[category].get(flag) is True
        ]
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError):
        return {"diagnostic": "invalid_error_body"}


async def _read_error_metadata(response: httpx.Response) -> dict[str, object]:
    # Avoid decoding/compression amplification. This is only a diagnostic probe;
    # an unknown encoding must not weaken or override the adapter's rejection.
    if response.headers.get("content-encoding", "identity").lower() != "identity":
        return {"diagnostic": "encoded_body_not_read"}
    raw = bytearray()
    try:
        async for chunk in response.aiter_raw(chunk_size=1024):
            if len(raw) + len(chunk) > _MAX_ERROR_BYTES:
                return {"diagnostic": "body_limit"}
            raw.extend(chunk)
        return _error_metadata(bytes(raw))
    except Exception:
        return {"diagnostic": "body_unavailable"}


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
        self.errors: list[dict[str, object]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # The adapter closes its client after each one-shot request. Give the
        # next fixed case a fresh pool, never a previously closed transport.
        if self.inner is None:
            self.inner = httpx.AsyncHTTPTransport(retries=0, trust_env=False)
        response = await self.inner.handle_async_request(request)
        self.statuses.append(response.status_code)
        if response.status_code != 200:
            self.errors.append({
                "request_index": len(self.statuses) - 1,
                "http_status": response.status_code,
                **await _read_error_metadata(response),
            })
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
    result["error_metadata"] = transport.errors
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
