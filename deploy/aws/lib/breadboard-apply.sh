#!/bin/bash
# Pull the deployed images and (re)create the Breadboard server container. cfn-init runs this on first boot; cfn-hup
# runs it again whenever a deploy changes /etc/breadboard/deploy.env (the instance's CloudFormation::Init metadata),
# so `cdk deploy -c serverImage=<new tag>` upgrades the host in place. The config repo on /var/breadboard stays put.
set -euo pipefail
DEPLOY_ENV="${BREADBOARD_DEPLOY_ENV:-/etc/breadboard/deploy.env}" # both overridable for the stack's tests only
OVERRIDES="${BREADBOARD_OVERRIDES_ENV:-/etc/breadboard/overrides.env}"
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

# Deployment settings that override the boot-time env file, in a root-only env file passed after it (docker applies the
# later file's values): PUBLIC_URL when set; an empty BREADBOARD_BOOTSTRAP_ADMIN_TOKEN (the server's "disabled") when
# the bootstrap admin is off; the trusted proxy, whose secret is fetched here so its value never enters a command
# line or the CloudFormation template; and the load-balancer identity settings when set.
umask 077
{
  if [[ -n "${PUBLIC_URL:-}" ]]; then echo "PUBLIC_URL=$PUBLIC_URL"; fi
  if [[ "${BOOTSTRAP_ADMIN:-true}" == "false" ]]; then echo "BREADBOARD_BOOTSTRAP_ADMIN_TOKEN="; fi
  if [[ -n "${TRUSTED_PROXY_SECRET_ARN:-}" ]]; then
    proxy_secret=$(aws secretsmanager get-secret-value --region "$(echo "$TRUSTED_PROXY_SECRET_ARN" | cut -d: -f4)" --secret-id "$TRUSTED_PROXY_SECRET_ARN" --query SecretString --output text)
    echo "BREADBOARD_TRUSTED_PROXY_USER=$TRUSTED_PROXY_USER"
    echo "BREADBOARD_TRUSTED_PROXY_SECRET=$proxy_secret"
  fi
  if [[ -n "${ALB_AUTH_ARN:-}" ]]; then echo "BREADBOARD_ALB_AUTH_ARN=$ALB_AUTH_ARN"; fi
  if [[ -n "${ALB_AUTH_ISSUER:-}" ]]; then echo "BREADBOARD_ALB_AUTH_ISSUER=$ALB_AUTH_ISSUER"; fi
  if [[ -n "${ALB_AUTH_CLIENT_ID:-}" ]]; then echo "BREADBOARD_ALB_AUTH_CLIENT_ID=$ALB_AUTH_CLIENT_ID"; fi
  if [[ -n "${OIDC_ADOPT_HANDLES:-}" ]]; then echo "BREADBOARD_OIDC_ADOPT_HANDLES=$OIDC_ADOPT_HANDLES"; fi
} > "$OVERRIDES.tmp"
mv "$OVERRIDES.tmp" "$OVERRIDES"

# Recreate the container only when the deployment changed (including a rotated proxy secret). The restart also drops
# warm sandbox containers started from a previous sandbox image (the server removes leftover sandbox containers on start).
want=$(cat "$DEPLOY_ENV" "$OVERRIDES" | sha256sum | cut -c1-16)
have=$(docker inspect -f '{{ index .Config.Labels "breadboard.deploy" }}' breadboard 2>/dev/null || true)
if [[ "$want" == "$have" ]]; then
  echo "breadboard already runs deployment $want"
  exit 0
fi
# Stop first so the server shuts down gracefully (SIGTERM: it closes open MCP conversations and stops its sandboxes);
# `rm -f` alone kills it outright.
docker stop -t 30 breadboard 2>/dev/null || true
docker rm -f breadboard 2>/dev/null || true
# Root in the container: it holds the Docker socket (root-equivalent anyway) and writes the root-owned
# /var/breadboard bind mount. Tool code runs in unprivileged sibling containers.
docker create --name breadboard --restart unless-stopped --user root --label "breadboard.deploy=$want" \
  --env-file /etc/breadboard.env --env-file "$OVERRIDES" \
  -p "$SERVER_PORT:$SERVER_PORT" \
  -v /var/breadboard:/var/breadboard \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$SERVER_IMAGE"
# Tool containers live on the internal-only sandbox network; joining it lets them reach the egress proxy and the
# API at the container name `breadboard` (SANDBOX_EGRESS_PROXY_HOST, SANDBOX_API_URL in /etc/breadboard.env).
docker network connect breadboard-sandbox breadboard
docker start breadboard
echo "breadboard started deployment $want ($SERVER_IMAGE)"
