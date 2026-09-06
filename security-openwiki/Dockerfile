FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g openwiki@0.5.0
WORKDIR /repo
ENV OPENWIKI_PROVIDER=openai-compatible OPENWIKI_MODEL_ID=best_coding OPENWIKI_MAX_OUTPUT_TOKENS=4096
ENTRYPOINT ["openwiki", "code", "--update", "--print"]
