#!/bin/bash
# Bootstrap the Breadboard reference host: Docker + the server container, secrets from Secrets Manager.
# Rendered by the stack (renderUserData): every dollar-brace placeholder is a stack value, so shell variables
# here are always written brace-less ($NAME). The stack refuses to synth if a placeholder has no value.
set -euo pipefail
dnf install -y docker jq git
systemctl enable --now docker

REGION="${region}"
secret() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

# The RDS-generated secret holds the credentials; the endpoint and database name come from the stack.
DATABASE_URL=$(secret "${db_secret_arn}" | jq -r '"postgres://\(.username|@uri):\(.password|@uri)@${db_host}:${db_port}/${db_name}"')
TOKEN_SIGNING_KEY=$(secret "${token_secret_arn}")
BROKER_MASTER_KEY=$(secret "${broker_secret_arn}")

PUBLIC_URL="${public_url}"
if [[ "$PUBLIC_URL" == *"__IMDS__"* ]]; then
  TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
  PUBLIC_URL="http://$IP:${server_port}"
fi

mkdir -p /var/breadboard
cat >/etc/breadboard.env <<ENV
DATABASE_URL=$DATABASE_URL
DATABASE_SSL=require
PUBLIC_URL=$PUBLIC_URL
PORT=${server_port}
MODEL_PROVIDER=${model_provider}
AWS_REGION=$REGION
OBJECT_STORE=${object_store}
OBJECT_STORE_S3_BUCKET=${s3_bucket}
SANDBOX_RUNNER=${sandbox_runner}
SANDBOX_EGRESS_PROXY_HOST=breadboard
SANDBOX_API_URL=http://breadboard:${server_port}
TOKEN_SIGNING_KEY=$TOKEN_SIGNING_KEY
BROKER_MASTER_KEY=$BROKER_MASTER_KEY
LOG_PRETTY=false
ENV
chmod 600 /etc/breadboard.env

docker network create --internal breadboard-sandbox || true
docker pull "${image}"
docker rm -f breadboard || true
# Root in the container: it holds the Docker socket (root-equivalent anyway) and writes the root-owned
# /var/breadboard bind mount. Tool code runs in unprivileged sibling containers.
docker create --name breadboard --restart unless-stopped --user root \
  --env-file /etc/breadboard.env \
  -p ${server_port}:${server_port} \
  -v /var/breadboard:/var/breadboard \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "${image}"
# Tool containers live on the internal-only sandbox network; joining it lets them reach the egress proxy and the
# API at the container name `breadboard` (SANDBOX_EGRESS_PROXY_HOST, SANDBOX_API_URL above).
docker network connect breadboard-sandbox breadboard
docker start breadboard
