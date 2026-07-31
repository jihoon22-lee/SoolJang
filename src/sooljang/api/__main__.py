"""`sooljang-api` 콘솔 스크립트 진입점."""

import uvicorn

from sooljang.config import get_settings


def main() -> None:
    """개발용 서버를 기동한다. 운영에서는 컨테이너가 uvicorn 을 직접 실행한다."""
    settings = get_settings()
    uvicorn.run(
        "sooljang.api.app:create_app",
        factory=True,
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.environment == "local",
    )


if __name__ == "__main__":  # pragma: no cover
    main()
