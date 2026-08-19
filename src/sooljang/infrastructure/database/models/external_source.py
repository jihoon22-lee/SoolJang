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


class ExternalProductMatch(Base, EntityMixin):
    """ "이 제품 = 이 소스의 이 상품" 을 사용자가 확정한 기록(Task 34 PR1).

    이름 유사도 매칭은 아무리 좋아져도 100% 가 되지 않는다. 틀렸을 때 사용자가 한 번
    고쳐 두면 그 제품은 영구히 정확해지도록 하는 것이 이 테이블의 목적이다 — 조회할
    때마다 후보를 다시 고르지 않고 여기 적힌 상품을 그대로 쓴다.

    **고정은 사용자의 명시적 조작으로만 만들어진다.** 점수가 높다고 자동으로 고정하지
    않는다(오답을 영구화할 위험). LLM 재판정(Task 34 PR6)도 추천만 하고 고정은 사용자
    확인을 받는다.

    `external_url` 이 NOT NULL 인 것은 §8 절대 규칙 7("외부 데이터는 출처 URL 없이
    저장하지 않는다")의 귀결이다 — 출처를 모르는 고정은 성립하지 않는다.

    동기화 대상이 아니다(`SYNC_ENTITIES` 에 넣지 않는다). 외부 조회 자체가 온라인
    전용이고, `external_source`·`external_lookup_cache` 도 같은 이유로 빠져 있다.
    """

    __tablename__ = "external_product_match"

    source_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("external_source.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("product.id", ondelete="CASCADE"), nullable=False
    )
    #: 고정된 상품의 출처 URL. 조회 시점에도 소스의 `base_url` 과 같은 호스트인지 다시
    #: 확인한다 — 저장 후에 `base_url` 이 바뀔 수 있다(SSRF 방어, §7.2).
    external_url: Mapped[str] = mapped_column(Text, nullable=False)
    #: 화면에 "무엇으로 고정했는지" 보여주기 위한 상품명.
    external_name: Mapped[str] = mapped_column(Text, nullable=False)
    #: JSON API 아이템 식별자. `search.result_fields` 모드는 상세 페이지를 조회하지 않아
    #: 검색 결과에서 고정된 항목을 되찾아야 하는데, 그때 이 값으로 찾는다.
    external_key: Mapped[str | None] = mapped_column(String(200), default=None)
    confirmed_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        # 부분 유니크 인덱스. `uq_product_identity` 선례를 따른다 — soft delete 된 행이
        # 자리를 차지해 같은 (소스, 제품) 을 다시 고정하지 못하게 되는 것을 막는다.
        Index(
            "uq_external_product_match_identity",
            "source_id",
            "product_id",
            unique=True,
            postgresql_where="deleted_at IS NULL",
        ),
        Index("ix_external_product_match_user_id_product_id", "user_id", "product_id"),
    )

    def __repr__(self) -> str:
        return f"<ExternalProductMatch source={self.source_id} product={self.product_id}>"


class ExternalSourceProbe(Base, EntityMixin):
    """소스 하나에 실제로 조회를 시도한 기록 하나(Task 34 PR4).

    `ExternalLookupCache` 는 **성공한 조회만** 담는다(절대 규칙 7 + `ok` 가드) — 실패
    기록이 남는 곳이 없어 "이 소스가 언제부터 깨졌는지"를 알 방법이 없었다. 이 테이블은
    성공·실패를 가리지 않고 시도 결과를 그대로 남기는 운영 로그다. 절대 규칙 6(파생값
    저장 금지)에 걸리지 않는다 — 도메인 파생 지표가 아니라 다른 어디에서도 재계산할 수
    없는 1차 사실이다.

    소스별 최근 `PROBE_HISTORY_LIMIT`(`application/external_sources.py`)개만 남기는
    롤링 로그라 소프트 삭제를 쓰지 않는다 — `EntityMixin` 의 `deleted_at` 은 두되(공통
    컬럼 규약), 오래된 행은 하드 삭제한다.

    동기화 대상이 아니다(`SYNC_ENTITIES` 에 넣지 않는다) — `external_lookup_cache` 와
    같은 이유로, 순수 운영 로그이자 온라인 전용 기능의 부산물이다.
    """

    __tablename__ = "external_source_probe"

    source_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("external_source.id", ondelete="CASCADE"), nullable=False
    )
    attempted_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False)
    #: 셀렉터 일부가 깨져 부분 결과만 얻었는지. `ok=True` 여도 참일 수 있다.
    degraded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    warning: Mapped[str | None] = mapped_column(Text, default=None)

    __table_args__ = (
        Index("ix_external_source_probe_source_id_attempted_at", "source_id", "attempted_at"),
    )

    def __repr__(self) -> str:
        return f"<ExternalSourceProbe source={self.source_id} ok={self.ok}>"
