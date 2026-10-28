# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS service-build
WORKDIR /build/packages/team-service
COPY packages/team-service/package.json packages/team-service/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY packages/team-service/ ./
COPY src/shared/ /build/src/shared/
RUN ln -s /build/packages/team-service/node_modules /build/node_modules \
    && npm run typecheck && npm run build && npm run licenses

FROM ${NODE_IMAGE} AS web-build
WORKDIR /build/packages/team-web
COPY packages/team-web/package.json packages/team-web/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY packages/team-web/ ./
COPY src/shared/ /build/src/shared/
COPY src/renderer/src/ /build/src/renderer/src/
COPY resources/brand/ /build/resources/brand/
COPY resources/collaboration/ /build/resources/collaboration/
COPY package.json tailwind.config.js /build/
# Shared renderer files resolve browser dependencies from this package only.
RUN ln -s /build/packages/team-web/node_modules /build/node_modules \
    && npm run typecheck && npm run build && npm run licenses

FROM ${NODE_IMAGE} AS service-dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY packages/team-service/package.json packages/team-service/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TEAM_HOST=0.0.0.0 \
    TEAM_PORT=5441 \
    TEAM_DATA_DIR=/var/lib/trellis-team/data \
    TEAM_WEB_DIR=/app/web
WORKDIR /app
COPY --from=service-dependencies /app/package.json /app/package-lock.json ./
COPY --from=service-dependencies /app/node_modules/ ./node_modules/
COPY --from=service-build /build/packages/team-service/dist/ ./dist/
COPY --from=service-build /build/packages/team-service/THIRD-PARTY-LICENSES.txt /build/packages/team-service/dependency-notices.json ./
COPY --from=web-build /build/packages/team-web/dist/ ./web/
COPY --from=web-build /build/packages/team-web/licenses/ ./web/licenses/
RUN mkdir -p /var/lib/trellis-team \
    && chown node:node /var/lib/trellis-team \
    && chmod 0700 /var/lib/trellis-team
USER node
EXPOSE 5441
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:5441/ready', { signal: AbortSignal.timeout(4000) }); if (!r.ok || !(await r.json()).ok) process.exit(1)"]
CMD ["node", "dist/cli.mjs"]
