"""명시적 외부 속성 적용. 짧은 서버 서명 증거와 제품 revision을 함께 확인한다."""

import json
import uuid
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, ValidationFailedError
from sooljang.api.schemas.product import ProductUpdate
from sooljang.application.products import load_product
from sooljang.infrastructure.database.models import ExternalSource, ProviderConnection
from sooljang.infrastructure.external.matching import parse_name

APPLICABLE_FIELDS = frozenset({"name_en", "country", "region", "abv", "vintage", "age_years"})


def applicable_fields(fields: dict[str, Any]) -> dict[str, Any]:
    result = {}
    for key in APPLICABLE_FIELDS:
        value = fields.get(key)
        if value is None or isinstance(value, bool):
            continue
        try:
            validated = ProductUpdate.model_validate({key: value}).model_dump(
                mode="json", exclude_unset=True
            )
        except ValidationError:
            continue
        result.update(validated)
    return result


def issue_evidence(
    *,
    user_id: uuid.UUID,
    source: ExternalSource,
    fields: dict[str, Any],
    source_url: str,
    master_key: str,
    connection_revision: int | None,
) -> str:
    content = {
        "purpose": "discovery-apply",
        "user_id": str(user_id),
        "source_id": str(source.id),
        "source_revision": source.config_revision,
        "source_url": source_url,
        "connection_id": str(source.connection_id) if source.connection_id else None,
        "connection_revision": connection_revision,
        "fields": applicable_fields(fields),
    }
    return Fernet(master_key.encode()).encrypt(json.dumps(content).encode()).decode()


async def apply_evidence(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    product_id: uuid.UUID,
    expected_updated_at: Any,
    token: str,
    selected_fields: list[str],
    master_key: str,
) -> dict[str, Any]:
    try:
        evidence = json.loads(Fernet(master_key.encode()).decrypt(token.encode(), ttl=900))
        if evidence["purpose"] != "discovery-apply" or evidence["user_id"] != str(user_id):
            raise ValueError
        if not selected_fields or not set(selected_fields) <= APPLICABLE_FIELDS:
            raise ValueError
        fields = {key: evidence["fields"][key] for key in selected_fields}
    except InvalidToken, ValueError, KeyError, TypeError:
        raise ValidationFailedError(
            "적용할 외부 자료가 만료되었거나 올바르지 않습니다. 다시 조회하세요"
        ) from None
    product = await load_product(session, user_id=user_id, product_id=product_id, for_update=True)
    if product.updated_at != expected_updated_at:
        raise ConflictError("제품이 다른 화면에서 수정되었습니다. 최신 값을 확인하세요")
    if evidence["connection_id"]:
        connection = await session.scalar(
            select(ProviderConnection)
            .where(
                ProviderConnection.id == uuid.UUID(evidence["connection_id"]),
                ProviderConnection.user_id == user_id,
            )
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
        if (
            connection is None
            or connection.deleted_at
            or not connection.is_active
            or connection.config_revision != evidence["connection_revision"]
        ):
            raise ConflictError("검색 연결이 바뀌었습니다. 다시 조회하세요")
    if evidence.get("source_id"):
        source = await session.scalar(
            select(ExternalSource)
            .where(
                ExternalSource.id == uuid.UUID(evidence["source_id"]),
                ExternalSource.user_id == user_id,
                ExternalSource.deleted_at.is_(None),
            )
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
        if (
            source is None
            or source.config_revision != evidence["source_revision"]
            or not source.is_active
        ):
            raise ConflictError("외부 소스 설정이 바뀌었습니다. 다시 조회하세요")
    validated = ProductUpdate.model_validate(fields).model_dump(exclude_unset=True)
    for key, value in validated.items():
        setattr(product, key, value)
    await session.flush()
    await session.refresh(product)
    return {
        "product_id": str(product.id),
        "updated_at": product.updated_at,
        "applied_fields": selected_fields,
        "source_url": evidence["source_url"],
    }


def title_fields(title: str) -> dict[str, Any]:
    """검색 결과 제목에 명시된 도수·숙성 연수만 제안한다. 본문의 다른 술/작성연도는 배제한다."""
    facts = parse_name(title)
    return applicable_fields({"abv": facts.abv, "age_years": facts.age_years})


def issue_search_evidence(
    *,
    user_id: uuid.UUID,
    connection: ProviderConnection,
    title: str,
    source_url: str,
    master_key: str,
) -> str:
    content = {
        "purpose": "discovery-apply",
        "user_id": str(user_id),
        "source_id": None,
        "source_revision": None,
        "source_url": source_url,
        "connection_id": str(connection.id),
        "connection_revision": connection.config_revision,
        "fields": title_fields(title),
    }
    return Fernet(master_key.encode()).encrypt(json.dumps(content).encode()).decode()
