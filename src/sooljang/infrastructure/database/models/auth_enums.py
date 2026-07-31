"""인증 관련 enum.

`auth.py` 와 분리한 이유는 도메인·API 계층이 모델 전체를 import 하지 않고 권한 값만 참조할
수 있게 하기 위해서다.
"""

import enum


class UserRole(enum.StrEnum):
    """사용자 권한.

    지인 공유(Task 20)를 대비해 처음부터 둔다. 단일 사용자 시기에는 `owner` 만 쓴다.
    나중에 역할을 추가하려고 스키마를 바꾸는 것보다 지금 자리를 만드는 편이 싸다.
    """

    OWNER = "owner"
    VIEWER = "viewer"
