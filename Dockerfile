# syntax=docker/dockerfile:1
# Keep in sync with .bun-version.
ARG BUN_VERSION=1.4.3

# Dependencies are pure JS, so install them on the build host's platform: a
# multi-arch build (buildx --platform linux/amd64,linux/arm64) then never runs
# bun under QEMU emulation.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-alpine
LABEL org.opencontainers.image.title="ai-gateway" \
      org.opencontainers.image.description="OpenAI-compatible AI gateway (TypeScript, Bun, Hono)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/brokenstring314/ai-gateway"
# tini: PID 1 that forwards SIGTERM to bun and reaps zombies (MCP stdio children).
# hadolint ignore=DL3018
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    GATEWAY_ENV=production \
    GATEWAY_DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json LICENSE NOTICE ./
COPY src ./src
# uid/gid 1000 = the image's "bun" user; numeric so runAsNonRoot can verify it.
RUN mkdir -p /data /config && chown -R 1000:1000 /data
USER 1000:1000
VOLUME ["/data"]
EXPOSE 3000
STOPSIGNAL SIGTERM
# Liveness only; readiness (/readyz) is for the load balancer / k8s.
# Assumes the default server.port 3000; override HEALTHCHECK if you change it.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/index.ts", "serve", "-c", "/config/config.yaml"]
