#!/bin/bash
# One-time switch of the RDS master user to IAM authentication: GRANT rds_iam to it, after which RDS accepts only IAM
# tokens for it (the generated password stops working). Run over SSM once the server signs in with IAM tokens
# (DATABASE_IAM_AUTH in deploy.env), before deploying with -c dbMasterPassword=false: it signs in with the master
# password, read with the instance role. Idempotent; prints every login role and whether it is IAM-only.
set -euo pipefail
DEPLOY_ENV="${BREADBOARD_DEPLOY_ENV:-/etc/breadboard/deploy.env}" # overridable for the stack's tests only
source "$DEPLOY_ENV"
if [[ -z "${DB_SECRET_ARN:-}" ]]; then
  echo "this deployment no longer holds the master password (dbMasterPassword=false), so there is nothing to sign in with" >&2
  exit 1
fi

# The URL with the password goes into a root-only env file, never onto a command line (SSM records those).
umask 077
env_file=$(mktemp)
trap 'rm -f "$env_file"' EXIT
aws secretsmanager get-secret-value --region "$(echo "$DB_SECRET_ARN" | cut -d: -f4)" --secret-id "$DB_SECRET_ARN" --query SecretString --output text |
  jq -r '"MASTER_URL=postgres://\(.username|@uri):\(.password|@uri)@\(.host):\(.port)/\(.dbname)"' >"$env_file"

# The server image has node and pg; the host has no Postgres client. The database forces TLS.
read -r -d '' GRANT_JS <<'JS' || true
const pg = require('pg');
const client = new pg.Client({ connectionString: process.env.MASTER_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await client.connect();
  const { current_user: user } = (await client.query('SELECT current_user')).rows[0];
  await client.query('GRANT rds_iam TO ' + client.escapeIdentifier(user));
  // pg_has_role is true for any superuser, so those are labelled apart (on RDS only rdsadmin is one).
  const roles = await client.query(
    "SELECT rolname, rolsuper, pg_has_role(oid, 'rds_iam', 'MEMBER') AS iam FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'rds%' ORDER BY 1",
  );
  for (const r of roles.rows) console.log(r.rolname + ' ' + (r.rolsuper ? 'superuser' : r.iam ? 'iam-only' : 'PASSWORD'));
  await client.end();
})().catch((e) => {
  console.error('grant failed: ' + e.message);
  process.exit(1);
});
JS
docker run --rm --env-file "$env_file" "$SERVER_IMAGE" node -e "$GRANT_JS"
