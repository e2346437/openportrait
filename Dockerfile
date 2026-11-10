# syntax=docker/dockerfile:1.7
# OpenPortrait: one image for plain Docker and Unraid.

ARG NODE_VERSION=22
# Pinned by digest so a build is reproducible; Dependabot proposes new digests weekly (.github/dependabot.yml).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ARG CLOUDFLARED_VERSION=2026.10.7
ARG TINI_VERSION=0.19.0
ARG GOSU_VERSION=1.19

# ---- build: install everything, compile, then keep only production deps ----
FROM ${NODE_IMAGE} AS build
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
FROM ${NODE_IMAGE} AS runtime
ARG TARGETARCH
ARG CLOUDFLARED_VERSION
ARG TINI_VERSION
ARG GOSU_VERSION
ARG VERSION=dev
ARG COMMIT=
ARG BUILD_DATE=
LABEL org.opencontainers.image.title="OpenPortrait" \
      org.opencontainers.image.description="Self-hosted studio CRM and client galleries for photographers" \
      org.opencontainers.image.source="https://github.com/e2346437/openportrait" \
      org.opencontainers.image.url="https://openportrait.app" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"

# Debian DLA-4880-1. Use TLS and disable redirects and retries during the
# bootstrap upgrade because this layer starts with the affected APT client.
# The slim image lacks the OS trust bundle. Bootstrap with Node's bundled roots.
RUN node -e 'console.log(require("node:tls").rootCertificates.join("\n"))' > /tmp/apt-roots.pem \
  && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::https::CAInfo=/tmp/apt-roots.pem -o Acquire::Retries=0 -o Acquire::https::AllowRedirect=false update \
  && apt-get -o Acquire::https::CAInfo=/tmp/apt-roots.pem -o Acquire::Retries=0 -o Acquire::https::AllowRedirect=false install -y --no-install-recommends --only-upgrade apt libapt-pkg6.0 \
  && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' apt)" ge 2.6.2 \
  && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libapt-pkg6.0)" ge 2.6.2 \
  && rm -rf /tmp/apt-roots.pem /var/lib/apt/lists/*

# Static release binaries: cloudflared for the built-in tunnel, tini as PID 1, gosu to drop to PUID:PGID.
ADD --chmod=755 https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH} /usr/local/bin/cloudflared
ADD --chmod=755 https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static-${TARGETARCH} /usr/bin/tini
ADD --chmod=755 https://github.com/tianon/gosu/releases/download/${GOSU_VERSION}/gosu-${TARGETARCH} /usr/local/bin/gosu
RUN cloudflared --version && gosu --version && tini --version

# Trim what the app never uses at run time (SEC-008, SEC-014): the package managers carry their own CVEs, and
# set-uid/set-gid bits are privilege-escalation paths. Also give Unraid's default ids (99:100) an account now, so the
# entrypoint never has to write /etc and the container can run with a read-only root filesystem.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true \
  && (getent passwd 99 >/dev/null || useradd -o -u 99 -g 100 -d /config -s /usr/sbin/nologin -K UID_MIN=1 nobody99)

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
    OPENPORTRAIT_COMMIT=${COMMIT} \
    OPENPORTRAIT_BUILT=${BUILD_DATE} \
    PUID=1000 \
    PGID=1000 \
    UMASK=022

RUN mkdir -p /config /galleries /incoming /cache
VOLUME ["/config", "/galleries", "/incoming", "/cache"]
EXPOSE 8080 2222 2121 30000-30009

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/apps/server/dist/main.js"]
