"""깨진 소스 명세가 조회 전체를 500 으로 만들지 않고 설정 오류로 끝나는지."""

import uuid
from typing import Any, cast

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ValidationFailedError
from sooljang.application.provider_connections import validate_source_connection
from sooljang.infrastructure.database.models import ExternalSource, ProviderConnection


@pytest.mark.parametrize(
    "spec",
    [
        {"search": "x"},
        {"search": ["https://api.search.brave.com"]},
        {"search": {"url_template": "http://[::1"}},
    ],
)
async def test_malformed_search_spec_is_reported_as_configuration_error(spec: Any) -> None:
    owner = uuid.uuid4()
    source = ExternalSource(
        user_id=owner,
        name="깨진 명세",
        base_url="https://example.com",
        adapter_spec=spec,
    )
    connection = ProviderConnection(user_id=owner, provider_kind="brave", name="브레이브")

    with pytest.raises(ValidationFailedError):
        await validate_source_connection(cast(AsyncSession, None), source, connection)
