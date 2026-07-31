# 프론트엔드(정적 자산) 이미지.
# Tailscale 은 머신당 인증서를 1개만 발급하므로 단일 진입점이 필요하다. 이 컨테이너가
# 정적 자산을 서빙하고 /api 를 백엔드로 넘기는 리버스 프록시 역할을 함께 한다.

FROM node:24.18.0-bookworm-slim AS builder

WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build


FROM nginx:1.29-alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1
