# syntax=docker/dockerfile:1

# The build context is the repository root. Build through docker-compose.production.yml
# so the lockfile and the full Connector source are copied consistently.
FROM node:20-bookworm-slim AS dependencies

WORKDIR /app
COPY Connector/package.json Connector/package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* variables are compiled into browser assets by Next.js.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_AGENTIC_WS_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_PUBLIC_AGENTIC_WS_URL=${NEXT_PUBLIC_AGENTIC_WS_URL}

COPY --from=dependencies /app/node_modules ./node_modules
COPY Connector/ ./
RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # simple-git uses the system Git executable.  Keep its trust store explicit
    # so GitHub cloning works in a minimal Debian runtime image on EC2.
    GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# `next start` is used instead of Next's standalone output. Next 16's default
# Turbopack production build does not reliably emit `.next/standalone`, while
# `.next` plus the production dependency tree is supported by both Turbopack
# and Webpack builds.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next

# Repositories and uploaded local projects live on named volumes in production.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/tmp/repos /app/tmp/local-projects \
    && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start"]
