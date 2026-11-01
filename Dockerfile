# syntax=docker/dockerfile:1.7
# OpenPortrait: one image for plain Docker and Unraid.

ARG NODE_VERSION=22
ARG CLOUDFLARED_VERSION=2026.10.0
ARG TINI_VERSION=0.19.0
ARG GOSU_VERSION=1.19

# ---- build: install everything, compile, then keep only production deps ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/jobs/package.json packages/jobs/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && CI=true pnpm install --frozen-lockfile --prod --filter @openportrait/server...

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG TARGETARCH
ARG CLOUDFLARED_VERSION
ARG TINI_VERSION
ARG GOSU_VERSION
ARG VERSION=dev
LABEL org.opencontainers.image.title="OpenPortrait" \
      org.opencontainers.image.description="Self-hosted studio CRM and client galleries for photographers" \
      org.opencontainers.image.source="https://github.com/e2346437/openportrait" \
      org.opencontainers.image.url="https://openportrait.app" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"

# Static release binaries: cloudflared for the built-in tunnel, tini as PID 1, gosu to drop to PUID:PGID.
ADD --chmod=755 https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH} /usr/local/bin/cloudflared
ADD --chmod=755 https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static-${TARGETARCH} /usr/bin/tini
ADD --chmod=755 https://github.com/tianon/gosu/releases/download/${GOSU_VERSION}/gosu-${TARGETARCH} /usr/local/bin/gosu
RUN cloudflared --version && gosu --version && tini --version

WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/packages/config/package.json ./packages/config/package.json
COPY --from=build /src/packages/config/dist ./packages/config/dist
COPY --from=build /src/packages/db/package.json ./packages/db/package.json
COPY --from=build /src/packages/db/dist ./packages/db/dist
COPY --from=build /src/packages/db/migrations ./packages/db/migrations
COPY --from=build /src/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /src/packages/jobs/package.json ./packages/jobs/package.json
COPY --from=build /src/packages/jobs/dist ./packages/jobs/dist
COPY --from=build /src/packages/jobs/node_modules ./packages/jobs/node_modules
COPY --from=build /src/apps/server/package.json ./apps/server/package.json
COPY --from=build /src/apps/server/dist ./apps/server/dist
COPY --from=build /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=755 docker/openportrait /usr/local/bin/openportrait

ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIR=/app/apps/web/dist \
    CLOUDFLARED_PATH=/usr/local/bin/cloudflared \
    OPENPORTRAIT_VERSION=${VERSION} \
    PUID=1000 \
    PGID=1000 \
    UMASK=022

RUN mkdir -p /config /galleries /incoming /cache
VOLUME ["/config", "/galleries", "/incoming", "/cache"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/apps/server/dist/main.js"]
