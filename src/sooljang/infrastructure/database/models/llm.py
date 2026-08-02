"""LLM API 설정 모델.

라벨 OCR(Task 17)이 Vision LLM 을 호출하려면 제공자·API 키·모델명이 필요하다. 사용자가
`.env` 를 직접 고치지 않고 앱 안의 설정 화면에서 관리할 수 있어야 한다는 요구(Task 17
착수 시점 사용자 결정)에 따라 DB 에 저장한다.

API 키는 평문으로 저장하지 않는다. `infrastructure/security/secrets.py` 의 Fernet
대칭 암호화로 암호화한 바이트만 `api_key_ciphertext` 에 넣는다 — 비밀번호와 달리 원문을
다시 꺼내 LLM API 호출에 써야 하므로 단방향 해시(Argon2)는 쓸 수 없다.

**동기화 대상이 아니다.** `application/sync.py::SYNC_ENTITIES` 에 의도적으로 넣지 않는다.
API 키가 클라이언트 IndexedDB(Dexie)에 평문으로 미러링되면 브라우저 저장소에 그대로
노출된다 — 이 값은 서버에서만 쓰인다.
"""

import enum

from sqlalchemy import LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin, str_enum_column


class LlmProvider(enum.StrEnum):
    """지원하는 LLM 제공자. 지금은 OpenAI 하나뿐이다 — 추상화를 앞서 만들지 않는다."""

    OPENAI = "openai"


#: Vision 입력을 지원하는 합리적인 기본 모델. 사용자가 설정 화면에서 바꿀 수 있다.
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"


class LlmSetting(Base, EntityMixin):
    """사용자별 LLM 설정. 사용자당 활성 행이 최대 1개다(애플리케이션 계층이 강제한다).

    DB 유니크 제약을 두지 않는 이유는, 설정을 지웠다가(soft delete) 다시 저장하는 흐름과
    `(user_id)` 유니크 제약이 충돌하기 때문이다 — 삭제된 행이 자리를 계속 차지해 재저장을
    막는다. 단일 사용자 앱에서 동시 저장 경쟁은 무시할 수 있는 위험이다.
    """

    __tablename__ = "llm_setting"

    provider: Mapped[LlmProvider] = mapped_column(
        str_enum_column(LlmProvider, "llm_provider", length=20), nullable=False
    )
    #: Fernet 암호문. base64 텍스트가 아니라 원시 바이트로 저장한다.
    api_key_ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    #: 키의 마지막 4자만 평문으로 따로 둔다. 화면에 "...ab12" 처럼 보여줘 사용자가 저장된
    #: 키를 알아볼 수 있게 하려는 용도다 — 이 정도로는 키를 재구성할 수 없어, 매번
    #: 복호화하지 않고도 조회 응답에 마스킹 값을 실을 수 있다.
    api_key_hint: Mapped[str] = mapped_column(String(4), nullable=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False, default=DEFAULT_OPENAI_MODEL)

    # `user_id` 단일 인덱스는 `EntityMixin` 이 이미 `index=True` 로 만든다. 복합 인덱스가
    # 필요 없다 — 동기화 대상이 아니라 `(user_id, updated_at)` 도 두지 않는다(§2.4 무관).

    def __repr__(self) -> str:
        return f"<LlmSetting user={self.user_id} provider={self.provider} model={self.model!r}>"
