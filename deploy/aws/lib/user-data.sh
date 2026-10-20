#!/bin/bash
# One-time setup of the Breadboard reference host: packages, Docker, secrets from Secrets Manager into
# /etc/breadboard.env, and the sandbox network. cfn-init then installs and runs breadboard-apply (images + container).
# Rendered by the stack (renderUserData): every dollar-brace placeholder is a stack value, so shell variables
# here are always written brace-less ($NAME). The stack refuses to synth if a placeholder has no value.
set -euo pipefail
dnf install -y docker jq git aws-cfn-bootstrap
systemctl enable --now docker

REGION="${region}"
secret() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

# The database connection (no password: RDS IAM tokens) comes from the deployment metadata, via breadboard-apply.
TOKEN_SIGNING_KEY=$(secret "${token_secret_arn}")
BROKER_MASTER_KEY=$(secret "${broker_secret_arn}")
BOOTSTRAP_ADMIN_TOKEN=$(secret "${admin_secret_arn}")

PUBLIC_URL="${public_url}"
if [[ "$PUBLIC_URL" == *"__IMDS__"* ]]; then
  TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
  PUBLIC_URL="http://$IP:${server_port}"
fi

mkdir -p /var/breadboard
cat >/etc/breadboard.env <<ENV
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
BREADBOARD_BOOTSTRAP_ADMIN_TOKEN=$BOOTSTRAP_ADMIN_TOKEN
LOG_PRETTY=false
ENV
chmod 600 /etc/breadboard.env

docker network create --internal breadboard-sandbox || true
# The images and the server container are managed by /usr/local/bin/breadboard-apply, which cfn-init installs and
# runs next (and cfn-hup re-runs when a deploy changes the images).
