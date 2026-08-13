from __future__ import annotations

from uuid import uuid4

import pytest
from cosmaneura_scribe.repository import InMemoryRepository


@pytest.mark.asyncio
async def test_in_memory_transaction_rolls_back_on_failure() -> None:
    repository = InMemoryRepository()
    tenant_id = uuid4()

    with pytest.raises(RuntimeError, match="simulated failure"):
        async with repository.transaction(tenant_id) as transaction:
            await transaction.claim_idempotency(
                tenant_id=tenant_id,
                operation="test.operation",
                key="rollback-key-1000",
                request_fingerprint="a" * 64,
                entity_id=uuid4(),
            )
            raise RuntimeError("simulated failure")

    assert repository.idempotency == {}
