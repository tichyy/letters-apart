# Frontend
FROM node:24-bookworm-slim AS client
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY client/ ./
COPY assets/ /app/assets/
COPY world.json /app/world.json
RUN npm run build

# Server
FROM python:3.14-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /usr/local/bin/uv
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-cache

COPY server/ ./server/
COPY world.json ./
COPY --from=client /app/dist ./dist
RUN useradd --uid 10001 --user-group --no-create-home --no-log-init app \
    && mkdir /data && chown app:app /data

USER app

CMD ["/app/.venv/bin/uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
