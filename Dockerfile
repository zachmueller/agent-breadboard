# Agent Breadboard server image: API + UI static + orchestrator + CRDT sync + MCP server ([12] §1).
# Build:  docker build -t agent-breadboard:local .
# Run:    see deploy/compose.yaml
FROM node:26-alpine AS build
WORKDIR /src
RUN apk add --no-cache git python3
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/sandbox-runtime/package.json packages/sandbox-runtime/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
COPY config-seed ./config-seed
RUN npm run build
# npm nests a dependency under a workspace when the root holds another version of it (e.g. ajv@8 under
# packages/shared while a dev tool hoists ajv@6), so each runtime workspace's node_modules is copied too.
RUN mkdir -p packages/shared/node_modules packages/sandbox-runtime/node_modules packages/server/node_modules

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
# git: the configuration plane is a git repo managed by the server ([01] §10.4). python3: process-runner fallback for Python tools.
RUN apk add --no-cache git python3 tini && addgroup -S breadboard && adduser -S -G breadboard breadboard
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /src/packages/shared/dist ./packages/shared/dist
COPY --from=build /src/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /src/packages/sandbox-runtime/package.json ./packages/sandbox-runtime/package.json
COPY --from=build /src/packages/sandbox-runtime/dist ./packages/sandbox-runtime/dist
COPY --from=build /src/packages/sandbox-runtime/python ./packages/sandbox-runtime/python
COPY --from=build /src/packages/sandbox-runtime/node_modules ./packages/sandbox-runtime/node_modules
COPY --from=build /src/packages/server/package.json ./packages/server/package.json
COPY --from=build /src/packages/server/dist ./packages/server/dist
COPY --from=build /src/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /src/packages/ui/dist ./packages/ui/dist
COPY --from=build /src/config-seed ./config-seed
RUN mkdir -p /var/breadboard && chown -R breadboard:breadboard /var/breadboard /app
ENV PORT=4000 HOST=0.0.0.0 \
    CONFIG_REPO_DIR=/var/breadboard/config-repo \
    CONFIG_WORKTREE_CACHE_DIR=/var/breadboard/config-trees \
    OBJECT_STORE_DIR=/var/breadboard/objects \
    MIRROR_DIR=/var/breadboard/mirrors \
    CONFIG_SEED_DIR=/app/config-seed \
    UI_DIST_DIR=/app/packages/ui/dist \
    LOG_PRETTY=false
VOLUME ["/var/breadboard"]
EXPOSE 4000 4100
USER breadboard
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/main.js"]
