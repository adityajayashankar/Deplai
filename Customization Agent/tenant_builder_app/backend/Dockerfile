# syntax=docker/dockerfile:1

# Use the official Node distribution for customization quality gates and previews,
# while keeping Python 3.13 for the FastAPI application.
FROM node:20-bookworm-slim AS node-runtime

FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH=/usr/local/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Keep two parent directories above main.py: several existing customization paths
# intentionally resolve their default workspace from that layout.
WORKDIR /app/tenant_builder_app/backend
COPY ["Customization Agent/tenant_builder_app/backend/requirements.txt", "./requirements.txt"]
RUN pip install -r requirements.txt
COPY ["Customization Agent/tenant_builder_app/backend/", "./"]

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin deplai \
    && mkdir -p logs tenants \
    && chown -R deplai:deplai /app
USER deplai

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8010/health', timeout=3)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8010"]
