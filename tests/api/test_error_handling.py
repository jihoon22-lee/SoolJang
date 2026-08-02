"""장애 주입: DB 접속 끊김 등 예상 밖 예외가 안전하게 처리되는지(Task 21).

`api/errors.py::register_error_handlers` 는 "모든 에러를 Problem Details 로 통일한다"고
적혀 있지만, 실제로는 DB 접속 실패 같은 처리기 없는 예외가 Starlette 기본 처리(일반 텍스트
500)로 새는 문서-코드 괴리가 있었다. 여기서는 그 회귀를 막는다.
"""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from sooljang.api import deps as deps_module


def test_예상치_못한_예외는_문제상세_형식_500으로_응답한다(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DB 접속이 끊기는 것처럼, 어떤 핸들러에도 안 걸리는 예외가 나도 이 API 만의
    일반 텍스트 500(Starlette 기본값)이 아니라 나머지 엔드포인트와 같은 Problem
    Details 형식으로 응답해야 한다.
    """

    def _broken_session_factory() -> Any:
        raise OperationalError("connection failed", None, Exception("connection refused"))

    monkeypatch.setattr(deps_module, "get_session_factory", _broken_session_factory)

    response = api_client.get(f"{prefix}/products")

    assert response.status_code == 500
    body = response.json()
    assert body["type"] == "https://sooljang.local/errors/internal"
    assert body["status"] == 500
    # 원인(쿼리·스택)은 노출하지 않는다 — 서버 로그에서만 확인한다.
    assert "connection refused" not in response.text


def test_예상치_못한_예외_후에도_후속_요청은_정상_처리된다(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """한 요청이 500 으로 끝나도 커넥션 풀·세션 상태가 다음 요청까지 오염시키면 안 된다."""

    def _broken_session_factory() -> Any:
        raise OperationalError("connection failed", None, Exception("connection refused"))

    monkeypatch.setattr(deps_module, "get_session_factory", _broken_session_factory)
    failed = api_client.get(f"{prefix}/products")
    assert failed.status_code == 500

    monkeypatch.undo()

    recovered = api_client.get(f"{prefix}/products")
    assert recovered.status_code == 200
