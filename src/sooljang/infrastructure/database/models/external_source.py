"""외부 소스 레지스트리와 조회 캐시(Task 18).

`docs/architecture.md` §7 이 정의한 `adapter` 전략만 이번 배치에서 구현한다 — `search`
전략(구글 검색 결과 스크래핑)은 ToS·신뢰성 위험이 있어 별도 PR 로 미뤘다(사용자 결정).

`ExternalSource` 는 사용자가 등록한 사이트 하나(데일리샷, 이마트 등)와 그 사이트를 파싱할
`adapter_spec` 셀렉터를 담는다. `ExternalLookupCache` 는 조회 결과를 `ttl_hours` 동안
재사용하기 위한 캐시이자, 마지막으로 무엇을 봤는지의 기록이다 — 이 앱은 단일 프로세스로만
배포되므로(§8.1) rate limit·robots.txt 캐시는 애플리케이션 계층 메모리로 충분하고, DB 에는
재조회를 피하기 위한 TTL 캐시만 둔다.
"""

import datetime
import uuid
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class ExternalSource(Base, EntityMixin):
    """사용자가 등록한 외부 조회 대상 사이트 하나.

    `adapter_spec` 은 `docs/architecture.md` §7.2 의 YAML 스키마와 같은 모양을 JSON 으로
    저장한다(`search.url_template`/`search.item`/`search.fields`, `detail.fields`) — 별도
    파서 없이 그대로 역직렬화해 쓴다.
    """

    __tablename__ = "external_source"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    #: robots.txt 확인과 상대 URL 절대화에 쓰는 사이트 루트(예: `https://example.com`).
    base_url: Mapped[str] = mapped_column(Text, nullable=False)
    #: 이 소스를 적용할 주종 범위. `None` 이면 모든 주종에 적용한다(전역 소스).
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("category.id", ondelete="SET NULL"), default=None
    )
    adapter_spec: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    #: 낮을수록 먼저 시도한다. 같은 주종에 소스가 여럿이면 이 순서로 조회해 첫 성공(또는
    #: degraded)을 쓴다.
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    rate_limit_per_min: Mapped[int] = mapped_column(Integer, nullable=False, default=6)
    ttl_hours: Mapped[int] = mapped_column(Integer, nullable=False, default=24)
    note: Mapped[str | None] = mapped_column(Text, default=None)

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_external_source_user_id_name"),
        Index("ix_external_source_user_id_category_id", "user_id", "category_id"),
    )

    def __repr__(self) -> str:
        return f"<ExternalSource {self.name!r} active={self.is_active}>"


class ExternalLookupCache(Base, EntityMixin):
    """소스별·제품별 최근 조회 결과. `ttl_hours` 내 재조회 요청은 이 값을 그대로 돌려준다.

    `snapshot` 은 `FetchedSnapshot`(§7.1)과 같은 모양의 JSON — `ratings`/`reviews`/
    `prices`/`source_url`/`raw_excerpt`. `source_url` 없는 결과는 애초에 여기 저장하지
    않는다(절대 규칙, `application/external_sources.py` 가 강제한다).
    """

    __tablename__ = "external_lookup_cache"

    source_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("external_source.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("product.id", ondelete="CASCADE"), nullable=False
    )
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    #: 셀렉터 일부가 깨져 부분 결과만 얻었는지. 참이면 UI 가 "일부 정보만 확인됨"을 보여준다.
    degraded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    warning: Mapped[str | None] = mapped_column(Text, default=None)
    fetched_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index(
            "ix_external_lookup_cache_source_id_product_id", "source_id", "product_id", "fetched_at"
        ),
    )

    def __repr__(self) -> str:
        return f"<ExternalLookupCache source={self.source_id} product={self.product_id}>"
