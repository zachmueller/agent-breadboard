#!/bin/bash
# Pull the deployed images and (re)create the Breadboard server container. cfn-init runs this on first boot; cfn-hup
# runs it again whenever a deploy changes /etc/breadboard/deploy.env (the instance's CloudFormation::Init metadata),
# so `cdk deploy -c serverImage=<new tag>` upgrades the host in place. The config repo on /var/breadboard stays put.
set -euo pipefail
DEPLOY_ENV="${BREADBOARD_DEPLOY_ENV:-/etc/breadboard/deploy.env}" # overridable for the stack's tests only
source "$DEPLOY_ENV"

# Private ECR registries need a login (the instance role grants pull on the image repositories).
pull() {
  local host region
  host=$(echo "$1" | cut -d/ -f1)
  if [[ "$host" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$ ]]; then
    region=$(echo "$host" | cut -d. -f4)
    aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$host"
  fi
  docker pull "$1"
}

pull "$SERVER_IMAGE"
# Tool sandbox images, tagged with the names breadboard.yaml uses by default (sandbox.images).
if [[ -n "$SANDBOX_IMAGE_TS" ]]; then pull "$SANDBOX_IMAGE_TS" && docker tag "$SANDBOX_IMAGE_TS" breadboard-sandbox-ts:local; fi
if [[ -n "$SANDBOX_IMAGE_PY" ]]; then pull "$SANDBOX_IMAGE_PY" && docker tag "$SANDBOX_IMAGE_PY" breadboard-sandbox-py:local; fi

# Recreate the container only when the deployment changed. The restart also drops warm sandbox containers started
# from a previous sandbox image (the server removes leftover sandbox containers on start).
want=$(sha256sum "$DEPLOY_ENV" | cut -c1-16)
have=$(docker inspect -f '{{ index .Config.Labels "breadboard.deploy" }}' breadboard 2>/dev/null || true)
if [[ "$want" == "$have" ]]; then
  echo "breadboard already runs deployment $want"
  exit 0
fi
docker rm -f breadboard 2>/dev/null || true
# Root in the container: it holds the Docker socket (root-equivalent anyway) and writes the root-owned
# /var/breadboard bind mount. Tool code runs in unprivileged sibling containers.
# Deployment settings that override the boot-time env file (docker applies -e after --env-file): PUBLIC_URL when set,
# and an empty BREADBOARD_BOOTSTRAP_ADMIN_TOKEN (the server's "disabled") when the bootstrap admin is turned off.
overrides=()
if [[ -n "${PUBLIC_URL:-}" ]]; then overrides+=(-e "PUBLIC_URL=$PUBLIC_URL"); fi
if [[ "${BOOTSTRAP_ADMIN:-true}" == "false" ]]; then overrides+=(-e "BREADBOARD_BOOTSTRAP_ADMIN_TOKEN="); fi
docker create --name breadboard --restart unless-stopped --user root --label "breadboard.deploy=$want" \
  --env-file /etc/breadboard.env ${overrides[@]+"${overrides[@]}"} \
  -p "$SERVER_PORT:$SERVER_PORT" \
  -v /var/breadboard:/var/breadboard \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$SERVER_IMAGE"
# Tool containers live on the internal-only sandbox network; joining it lets them reach the egress proxy and the
# API at the container name `breadboard` (SANDBOX_EGRESS_PROXY_HOST, SANDBOX_API_URL in /etc/breadboard.env).
docker network connect breadboard-sandbox breadboard
docker start breadboard
echo "breadboard started deployment $want ($SERVER_IMAGE)"
