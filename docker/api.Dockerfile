# 백엔드(FastAPI) 이미지.
# 빌드 단계와 실행 단계를 분리해 빌드 도구가 최종 이미지에 남지 않게 한다.
#
# uv 공식 이미지에는 Python 3.14 태그가 없어, python:3.14-slim 위에 버전을 고정한
# 설치 스크립트로 uv 를 넣는다. 버전을 고정하지 않으면 재현 가능한 빌드가 깨진다.

FROM python:3.14-slim-bookworm AS builder

ARG UV_VERSION=0.11.29

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_INSTALL_DIR=/usr/local/bin

RUN apt-get update \
    && apt-get install --no-install-recommends -y curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && uv --version

WORKDIR /app

# 의존성만 먼저 설치해 소스 변경이 의존성 레이어를 무효화하지 않게 한다.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# README.md 는 pyproject 의 `readme` 가 참조하므로 hatchling 빌드에 필요하다.
COPY README.md ./
COPY src ./src
COPY alembic.ini ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev


FROM python:3.14-slim-bookworm AS runtime

# 루트로 실행하지 않는다. 컨테이너 탈출 시 피해 범위를 줄인다.
RUN groupadd --system --gid 1001 sooljang \
    && useradd --system --uid 1001 --gid sooljang --create-home sooljang

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY --from=builder --chown=sooljang:sooljang /app/.venv ./.venv
COPY --from=builder --chown=sooljang:sooljang /app/src ./src
COPY --from=builder --chown=sooljang:sooljang /app/alembic.ini ./alembic.ini

USER sooljang

EXPOSE 8000

# 컨테이너 오케스트레이터가 준비 상태를 판단할 수 있게 한다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "sooljang.api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
