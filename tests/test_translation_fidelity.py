import json

import pytest
from cosmaneura_scribe.translation_adapter import (
    SpanishToEnglishTranslationResult,
    TranslationAdapterError,
    TranslationAdapterFailureCode,
)
from cosmaneura_scribe.translation_fidelity import (
    SYNTHETIC_CASES,
    qualify_synthetic_translation,
)


class ReferenceAdapter:
    adapter_id = "fixture_only"
    model_profile_id = "fixture_v1"

    async def translate(self, request):
        case = next(c for c in SYNTHETIC_CASES if c.source == request.content)
        return SpanishToEnglishTranslationResult(case.accepted[0])


@pytest.mark.asyncio
async def test_reference_smoke_reports_only_bounded_metadata_and_limited_acceptance():
    result = await qualify_synthetic_translation(ReferenceAdapter())
    assert result["reference_agreement_count"] == len(SYNTHETIC_CASES)
    encoded = json.dumps(result)
    assert result["clinical_acceptance"] == "not_established"
    assert all(case.source not in encoded and case.accepted[0] not in encoded
               for case in SYNTHETIC_CASES)


@pytest.mark.asyncio
async def test_negation_reversal_does_not_pass_reference_agreement():
    class WrongAdapter(ReferenceAdapter):
        async def translate(self, request):
            return SpanishToEnglishTranslationResult("I have chest pain.")
    result = await qualify_synthetic_translation(WrongAdapter())
    assert result["reference_agreement_count"] == 0
    assert all(case["result"] == "review_required" for case in result["cases"])


@pytest.mark.asyncio
async def test_first_provider_failure_stops_live_calls():
    class FailedAdapter(ReferenceAdapter):
        async def translate(self, request):
            raise TranslationAdapterError(TranslationAdapterFailureCode.PROVIDER_UNAVAILABLE)
    result = await qualify_synthetic_translation(FailedAdapter())
    assert result["case_count"] == 1
    assert result["reference_agreement_count"] == 0
