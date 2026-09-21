# Operator-built preview image. Repository Dockerfiles are never executed here.
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS node
FROM python:3.12-slim@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql redis-server ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 65532 --no-create-home --home-dir /runtime/home deplai
COPY supervisor.py /opt/deplai/supervisor.py
USER 65532:65532
ENV HOME=/runtime/home PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-I", "/opt/deplai/supervisor.py"]
