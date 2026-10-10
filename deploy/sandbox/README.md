# Tool sandbox images and posture

Tool extensions run in throwaway sandboxes ([06 — Toolbox](../../specs/06-toolbox.md) §4, [12 — Security & Deployment](../../specs/12-security-deployment.md) §6). This directory holds the two sandbox images and explains how the server isolates them.

| Image (default tag) | Dockerfile | Used for |
|---|---|---|
| `breadboard-sandbox-ts:local` | `Dockerfile.ts` (`node:26-alpine`) | `language: typescript` tools (`.ts` via Node type stripping, or `.js`/`.mjs`) |
| `breadboard-sandbox-py:local` | `Dockerfile.py` (`python:3.12-alpine`) | `language: python` tools |

To use different tags, set `sandbox.images.typescript` / `sandbox.images.python` in `breadboard.yaml`.

## Build

Run from the repository root:

```sh
npm run build -w @breadboard/sandbox-runtime          # produces packages/sandbox-runtime/dist
docker build -f deploy/sandbox/Dockerfile.ts -t breadboard-sandbox-ts:local .
docker build -f deploy/sandbox/Dockerfile.py -t breadboard-sandbox-py:local .
```

What the images contain:
- An unprivileged user, `10001:10001`.
- The runner in `/runtime`, owned by root and read-only to the sandbox user.
- An empty `/tool` volume.
- The default `CMD` uses exec form and needs no shell.

The package managers (`apk`, `npm`, `pip`) are removed. To debug a tool by hand:

```sh
docker run -i --rm --read-only --tmpfs /work --network none \
  -v "$PWD/my-tool:/tool:ro" breadboard-sandbox-ts:local < request.json
```

Python tools that need third-party packages can either vendor them in the tool directory or use a derived image referenced from `sandbox.images.python`. The base image has no pip, so restore it for the install and remove it again:

```dockerfile
FROM breadboard-sandbox-py:local
USER root
RUN python3 -m ensurepip \
 && python3 -m pip install --no-cache-dir strands-agents \
 && python3 -m pip uninstall -y pip
USER 10001:10001
```

## Runner modes

Set the mode with `SANDBOX_RUNNER`:

- **`docker`** (production). Each tool execution gets its own container, which is removed afterwards. Containers are never reused.
- **`process`** (default; dev and tests only). Tool code runs as a local child process. There are no resource limits beyond the wall-clock kill, no filesystem isolation, and no network isolation beyond proxy environment variables that tool code could ignore. The server logs a warning once at startup in this mode. Do not run untrusted tools in this mode.

## What the docker runner enforces

Every tool container is created with these settings (`packages/server/src/toolbox/sandbox/docker.ts`, `buildHostConfig`):

| Control | Setting |
|---|---|
| User | `10001:10001` (non-root), `no-new-privileges`, `CapDrop: ALL`, not privileged |
| Filesystem | `ReadonlyRootfs: true`. Tmpfs at `/work` and `/tmp` (`noexec,nosuid,nodev`, size-capped). Tool code goes in `/tool`, root-owned, so the sandbox user can only read it. |
| Resources | From the tool manifest `limits`: `Memory` (with swap equal to memory, so no swap), `NanoCpus`, `PidsLimit`, and a wall-clock `timeout_s` enforced with SIGKILL |
| Network | Attached **only** to the internal network `breadboard-sandbox`, which has no external route. Egress goes through the egress proxy only. |
| Runtime | `SANDBOX_OCI_RUNTIME` (for example `runsc` for gVisor). Recommended wherever untrusted tool code runs. |
| Docker socket | Never mounted into tool containers |
| Output | stdout/stderr are capped. Large logs are spilled to object storage and referenced from the execution record. |

**Warm pool** (`SANDBOX_WARM_POOL_SIZE`, default 2 per language):
- Containers are pre-started with an idle process. When one is taken for an execution, the tool's limits are applied with `docker update`.
- After that one execution the container is removed. Containers are never returned to the pool.
- On startup the server removes any containers labelled `breadboard.sandbox=1` that a previous process left behind.

## Network: internal-only plus the egress proxy

Tools are default-deny. A tool can reach only:
- the hosts and ports listed in its manifest `egress.allow`, and
- the Breadboard API, which is an implicit destination.

Enforcement is done by the egress proxy that runs inside the server process (`SANDBOX_EGRESS_PROXY_PORT`, default 4100):

- **Per-execution credentials.** Each execution gets `HTTP(S)_PROXY=http://<execution_key>:<nonce>@<proxy-host>:<port>`. The proxy accepts a request only when the credentials match an execution that is currently registered. Requests without credentials get `407`.
- **Plain HTTP and CONNECT.** The proxy forwards plain HTTP requests and opens tunnels for `CONNECT` (HTTPS). Destinations outside the allowlist get `403`.
- **Host patterns.** Patterns are exact hosts or `*.example.com`, which matches subdomains only. A bare `*` is never honoured.
- **Audit.** Every decision, allowed or denied, is written to the `egress_audit` table and the server log.

The internal network is the reason the proxy cannot be bypassed: a container that ignores the proxy variables has no route anywhere. Create the network as internal yourself, or let the server create it on first start:

```sh
docker network create --internal breadboard-sandbox
```

If a network with that name exists but is **not** internal, the server logs an error at startup. Recreate the network in that case.

### Making the proxy reachable from the sandbox network

Containers reach the proxy at `SANDBOX_EGRESS_PROXY_HOST`, which defaults to `host.docker.internal`. Each container maps that name to the host gateway through `ExtraHosts`. An `--internal` network has no route off its own bridge, so whether the host gateway is reachable depends on where the server runs:

- **Server in a container** (recommended; `deploy/compose.sandbox-docker.yaml`, and the AWS host in `deploy/aws`): attach the server container to `breadboard-sandbox` as well and point the sandboxes at its name. Verified on Colima (macOS) with the compose override:

  ```yaml
  services:
    server:
      environment:
        SANDBOX_RUNNER: docker
        SANDBOX_EGRESS_PROXY_HOST: server       # the server's DNS name on breadboard-sandbox
        SANDBOX_API_URL: http://server:4000     # the URL tool code uses for ctx primitives
      networks: [default, sandbox]
  networks:
    sandbox:
      name: breadboard-sandbox
      internal: true
  ```

  On this topology the sandboxes still have no route to the internet. Their only reachable peer is the server, whose proxy enforces the allowlists.
- **Server on a macOS host with Colima:** the host gateway is *not* reachable from the internal network (`ENETUNREACH`; verified 2026-10-01). Run a relay container that sits on both networks and forwards only the proxy port, then point the sandboxes at it:

  ```sh
  docker run -d --name bb-egress-relay --restart unless-stopped --add-host host.docker.internal:host-gateway \
    alpine/socat TCP-LISTEN:4100,fork,reuseaddr TCP:host.docker.internal:4100
  docker network connect breadboard-sandbox bb-egress-relay
  # .env: SANDBOX_EGRESS_PROXY_HOST=bb-egress-relay
  #       SANDBOX_DOCKER_SOCKET=$HOME/.colima/default/docker.sock
  ```

  Colima delivers the relay's traffic to the host's loopback, so `PUBLIC_URL=http://localhost:4000` works as the API destination. The relay only reaches the proxy, which still requires per-execution credentials.
- **Docker Desktop, server on the host:** not yet verified. If the host gateway turns out to be unreachable from the internal network, use the relay above.
- **Linux, server on the host:** not yet verified. The proxy binds `0.0.0.0` by default; firewall rules must allow the `breadboard-sandbox` bridge to reach port 4100.

**Tool code calls back into the Breadboard API** for ctx primitives such as `createArtifact` and `runTool`:
- It uses `BREADBOARD_API_URL` (`SANDBOX_API_URL`, else the server's `PUBLIC_URL`) and an execution-scoped actor token. The token's TTL is the tool timeout plus 60 s.
- In docker mode these calls also go through the proxy, with the API host as the implicit destination. `SANDBOX_API_URL` (or `PUBLIC_URL`) must therefore resolve and be reachable *from the proxy*. Set `SANDBOX_API_URL` when the server joins the sandbox network under a container name, so `PUBLIC_URL` can stay browser-facing.

## Credentials

Sandboxes never hold credentials. Tools that call authenticated APIs do so through the credential broker (`ctx.fetch(capability, request)` in both runtimes):
- The broker attaches the credential server-side.
- It applies only the capabilities the tool's manifest declares, and only within the capability's host, method, and path scope.
- Every call is written to `broker_audit`.

Secrets are encrypted at rest with libsodium `secretbox`, using the key in `BROKER_MASTER_KEY`. Generate one with `openssl rand -base64 32`.

## Hardening checklist for production

- Set `SANDBOX_RUNNER=docker`, and set `SANDBOX_OCI_RUNTIME=runsc` (gVisor) when tools are not fully trusted.
- Make sure `breadboard-sandbox` is `--internal`, and that nothing else is attached to it except the server or proxy.
- Set `BROKER_MASTER_KEY`. Production (`NODE_ENV=production`) refuses to start without it; in development the broker falls back to a key derived from `TOKEN_SIGNING_KEY` and logs a loud warning.
- Review `egress.allow` in tool PRs. Wildcard entries are flagged by tool CI.
- Only the server process should have access to the Docker socket. Prefer a socket proxy that limits it to the container, exec, archive, and network endpoints the runner uses.
