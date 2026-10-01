# Agent Breadboard tool sandbox image: TypeScript / JavaScript tool extensions ([06] §4, [12] §6).
#
# Build from the repository root, after building the runtime package:
#   npm run build -w @breadboard/sandbox-runtime
#   docker build -f deploy/sandbox/Dockerfile.ts -t breadboard-sandbox-ts:local .
#
# The server's DockerSandboxRunner creates one container per execution from this image with a read-only root
# filesystem, tmpfs /work, all capabilities dropped, no-new-privileges, user 10001, and only the internal
# `breadboard-sandbox` network attached. It copies the tool directory into /tool and execs
#   node --disable-warning=ExperimentalWarning /runtime/runner-cli.js /tool
# with the RunnerRequest on stdin. `.ts` entrypoints run via Node's built-in type stripping, so tool code must
# use erasable TypeScript syntax only (no enums, namespaces, or parameter properties).
FROM node:26-alpine

LABEL org.opencontainers.image.title="breadboard-sandbox-ts" \
      org.opencontainers.image.description="Agent Breadboard tool sandbox (TypeScript)"

# Unprivileged sandbox user (uid/gid 10001, no home, no login shell). /tool and /runtime are root-owned and
# read-only to it; /work and /tmp are tmpfs mounts supplied at run time. The package manager is removed so
# nothing can be installed into a running sandbox even if a writable path were found.
RUN addgroup -S -g 10001 sandbox \
 && adduser -S -D -H -h /work -s /sbin/nologin -u 10001 -G sandbox sandbox \
 && mkdir -p /tool /work /runtime /node_modules/@breadboard/sandbox-runtime \
 && chown root:root /tool /runtime \
 && chmod 0755 /tool /runtime \
 && chmod 1777 /work \
 && rm -rf /sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# The runner (what the server execs) lives in /runtime; the same package is also resolvable as
# `@breadboard/sandbox-runtime` from /tool for tools that import runtime values rather than only types.
COPY packages/sandbox-runtime/dist/ /runtime/
COPY packages/sandbox-runtime/package.json /node_modules/@breadboard/sandbox-runtime/package.json
COPY packages/sandbox-runtime/dist/ /node_modules/@breadboard/sandbox-runtime/dist/
# COPY writes root-owned files; normalize modes so the sandbox user can read but never write them.
RUN chmod -R u=rwX,go=rX /runtime /node_modules

ENV NODE_ENV=production \
    HOME=/work \
    TMPDIR=/work \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

# /tool is populated per execution (putArchive into an anonymous volume, or a :ro bind mount).
VOLUME ["/tool"]
WORKDIR /work
USER 10001:10001

# Exec form, no shell. Manual use: docker run -i --rm -v "$PWD/mytool:/tool:ro" breadboard-sandbox-ts:local < request.json
CMD ["node", "/runtime/runner-cli.js", "/tool"]
