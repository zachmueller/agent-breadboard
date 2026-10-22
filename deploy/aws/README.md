# AWS reference deployment

A TypeScript CDK app that provisions the recommended production shape from [12 — Security & Deployment](../../specs/12-security-deployment.md) §1:

- **RDS Postgres 16** (encrypted, private, forced SSL, automated snapshots + PITR). The server signs in with RDS IAM tokens, not a password. This is the only required stateful dependency.
- **One reference server host** (EC2, Amazon Linux 2023, IMDSv2 only) running the Breadboard container. Docker runs the tool sandbox, an instance role provides Bedrock access, and secrets come from Secrets Manager.
- Optional **S3 bucket** (versioned, TLS-only) for large blobs.

This directory is a standalone npm package, not part of the root workspaces, so the CDK libraries stay out of the server build.

```bash
# 1. Build and push the images (the reference host is x86_64)
npm run build -w @breadboard/sandbox-runtime
R=<account>.dkr.ecr.<region>.amazonaws.com/agent-breadboard
docker buildx build --platform linux/amd64 -t $R:server-v0.1 --push .
docker buildx build --platform linux/amd64 -f deploy/sandbox/Dockerfile.ts -t $R:sandbox-ts-v0.1 --push .
docker buildx build --platform linux/amd64 -f deploy/sandbox/Dockerfile.py -t $R:sandbox-py-v0.1 --push .

# 2. Deploy (AWS credentials via the normal chain; bootstrap once per account and region)
cd deploy/aws
npm ci
npx cdk bootstrap
npx cdk deploy -c name=myteam -c vpcId=vpc-… -c dbSubnetIds=subnet-a,subnet-b \
  -c serverSubnetId=subnet-c -c serverImage=$R:server-v0.1 \
  -c sandboxImageTs=$R:sandbox-ts-v0.1 -c sandboxImagePy=$R:sandbox-py-v0.1
```

`npx cdk diff` with the same `-c` flags previews changes. `npm test` checks the synthesized template without an AWS account.

## Inputs

All inputs are CDK context: `-c key=value` on the command line, or a `context` block in `cdk.json`. Lists are comma-separated.

| Key | Default | Notes |
|---|---|---|
| `name` | required | Short name of this Breadboard. Resources are named `breadboard-<name>-…`; the stack is `Breadboard-<name>`. |
| `vpcId` | required | Looked up at synth time. The result is cached in `cdk.context.json` (gitignored here). |
| `dbSubnetIds` | required | Private subnets for RDS, in at least 2 AZs. |
| `serverSubnetId` | required | Must be a public subnet when `serverPublicIp` is true. Synth fails otherwise. |
| `serverImage` | required | The container image pushed above. |
| `sandboxImageTs` / `sandboxImagePy` | none | Tool sandbox images (`deploy/sandbox`). The host pulls them and tags them `breadboard-sandbox-ts:local` / `breadboard-sandbox-py:local`, the names `breadboard.yaml` uses by default. Without them no tool can run. |
| `region` | `CDK_DEFAULT_REGION`, else `us-east-1` | |
| `serverPublicIp` | `true` | |
| `allowedCidrs` | `0.0.0.0/0` | CIDRs allowed to reach the server port. `none` adds no inbound rule; reach the server with SSM port forwarding (`aws ssm start-session --document-name AWS-StartPortForwardingSession`). |
| `serverPort` | `4000` | |
| `serverInstanceType` | `t3.large` | x86_64, matching the AMI. |
| `serverRootVolumeGb` | `100` | |
| `publicUrl` | instance IP | Externally reachable base URL, `scheme://host[:port]` (e.g. the HTTPS address of a proxy in front of the server). Used for OIDC redirects and `Secure` cookies. When empty, the bootstrap script resolves the instance IP from IMDS. It lives in the deployment metadata, so it can be changed later like an image (see Upgrading). |
| `sandboxRunner` | `docker` | `docker` or `process`. |
| `trustedProxyUser` | none | Trusted proxy (see below): the handle that every request through your authenticating proxy signs in as. Generates the shared secret; applied in place. |
| `albAuthArn` | none | Load-balancer identity (see below): the ARN of an Application Load Balancer that authenticates users with OIDC; each request signs in as the user it names. Applied in place. |
| `albAuthIssuer` / `albAuthClientId` | none | With `albAuthArn`: pin the IdP issuer and OIDC client id the identity header must carry. |
| `oidcAdoptHandles` | none | Existing users without an OIDC subject (e.g. the `trustedProxyUser`) that the first OIDC or load-balancer sign-in with the same handle becomes. |
| `brokerRoleArns` | none | IAM roles the server may assume for `aws-role` broker credentials (see AWS APIs from tools). IAM-only change, applied in place. |
| `bootstrapAdmin` | `true` | Accept the generated bootstrap admin token. Set `false` once another admin can sign in (see First sign-in); applied in place, like `publicUrl`. |
| `dbEngineVersion` | `16` | |
| `dbInstanceClass` | `db.t4g.medium` | |
| `dbAllocatedStorageGb` / `dbMaxAllocatedStorageGb` | `50` / `500` | |
| `dbMultiAz` | `false` | |
| `dbBackupRetentionDays` | `14` | |
| `dbDeletionProtection` | `true` | |
| `dbMasterPassword` | `true` | Keep the generated master password in the stack. Must be `true` when the database is created; set `false` once the master user is IAM-only (see Database authentication), which also sets its authentication type to `iam-db-auth`. Applied without touching the host or replacing the database. |
| `enableS3Objects` | `true` | When false, blobs go to the host filesystem under `/var/breadboard`. |
| `tags` | none | Extra tags, e.g. `Team=research,CostCenter=1234`. `Project` and `Breadboard` are always set. |

## Secrets

Secrets Manager generates all four secrets, so their values never appear in the template, in CDK output, or on the deployer's machine:

- `breadboard-<name>/db`: the RDS master credentials (`username`, `password`), which RDS needs to create the instance. The server never uses them; the password exists for the one-time grant in Database authentication and is removed afterwards. The secret stays, holding the user name: the instance's master user name is a reference to it.
- `breadboard-<name>/token-signing-key`: `TOKEN_SIGNING_KEY`.
- `breadboard-<name>/broker-master-key`: `BROKER_MASTER_KEY`. 43 alphanumeric characters, which decode as base64 to exactly 32 bytes.
- `breadboard-<name>/admin-token`: `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN`, the break-glass sign-in for `bootstrap-admin` (see First sign-in). Kept when `bootstrapAdmin=false`.

## Database authentication

The server signs in to RDS as the master user `breadboard` with IAM tokens: `DATABASE_URL` (no password) and
`DATABASE_IAM_AUTH=true` live in the deployment metadata, and the instance role holds `rds-db:connect` for that user.
RDS still creates the instance with a password, so after the first deploy (or after upgrading a stack that predates IAM
auth) turn the password off once:

1. Grant `rds_iam` to the master user. For PostgreSQL, IAM authentication then takes precedence over its password:
   ```bash
   aws ssm send-command --instance-ids <ServerInstanceId> --document-name AWS-RunShellScript \
     --parameters 'commands=["/usr/local/bin/breadboard-db-grant-iam","docker restart breadboard"]'
   ```
   `breadboard-db-grant-iam` signs in with the master secret (read with the instance role, kept off command lines) inside
   the server image, runs the grant, and lists every login role as `iam-only`, `superuser` or `PASSWORD`. Until it has
   run, the server cannot sign in: it logs `RDS IAM authentication failed for database user breadboard` and restarts.
2. Deploy with `-c dbMasterPassword=false` (plus the usual `-c` set). The password leaves the template, the instance
   role loses read access to the secret, and the master user's authentication type becomes `iam-db-auth`. RDS cannot
   see the `rds_iam` grant, so without that setting it still counts the master user as a password user. The host is
   not touched (the container is recreated once). Preview it with `npx cdk deploy … --no-execute` and check the change
   set: the DB instance is modified in place (`MasterUserPassword` and `MasterUserAuthenticationType`), not replaced.
3. Remove the password from the secret, keeping the user name the template reads (the value stays off command lines):
   ```bash
   umask 077; f=$(mktemp)
   aws secretsmanager get-secret-value --secret-id breadboard-<name>/db --query SecretString --output text | jq -c 'del(.password)' > "$f"
   aws secretsmanager put-secret-value --secret-id breadboard-<name>/db --secret-string "file://$f"; rm -f "$f"
   ```
   The earlier version, with the now useless password, keeps the `AWSPREVIOUS` label; move that label onto the new
   version too (`update-secret-version-stage --version-stage AWSPREVIOUS --move-to-version-id <new> --remove-from-version-id <old>`)
   to leave the old version unlabelled.

Do not delete the secret or change `MasterUsername`: the master user name in the template is a reference to the secret,
and CloudFormation compares template text, so any change to it, even to the same name as a literal, replaces the
database.

Any principal with `rds-db:connect` for the user can mint a token (`aws rds generate-db-auth-token`), so there is no
lockout; `REVOKE rds_iam FROM breadboard` from such a session brings password sign-in back.

## First sign-in

The image runs with `NODE_ENV=production`, which refuses the seed's well-known `*-change-me` tokens. Sign in with the
generated bootstrap admin token, then switch `auth.mode` to OIDC (or set real local tokens) and deactivate
`bootstrap-admin` in Admin:

```bash
aws secretsmanager get-secret-value --secret-id breadboard-<name>/admin-token --query SecretString --output text
```

**Turning the bootstrap admin off.** Once another admin can sign in, deploy with `-c bootstrapAdmin=false` (plus the
usual `-c` set). The container is recreated with an empty token, which the server treats as disabled; `bootstrap-admin`
sessions stop working too. The host is not touched and the secret stays. If you are ever locked out, deploy with
`-c bootstrapAdmin=true` and sign in with the same token. At startup the server logs `no admin can sign in` (an error
in `docker logs breadboard`) if disabling left no admin path. An authenticating proxy in front of the server is not
such a path unless Breadboard trusts it (a trusted proxy, or an admin signing in through a load balancer), because
otherwise it does not tell Breadboard who you are. Deactivating `bootstrap-admin` in Admin is the permanent
alternative; it needs a second admin, since you cannot deactivate yourself.

## Upgrading the server

Deploy with a new image tag: `npx cdk deploy … -c serverImage=$R:server-v0.2` (same for the sandbox images). The images
live in the instance's CloudFormation::Init metadata, not in its user data, so the deploy neither restarts nor replaces
the host. cfn-hup on the host notices the metadata change within a minute or two, pulls the images, and recreates the
`breadboard` container (`/usr/local/bin/breadboard-apply`; log in `/var/log/cfn-hup.log`). The config repo on
`/var/breadboard` is untouched. `publicUrl` changes apply the same way. Preview an upgrade with `npx cdk diff … --method=template`: the default change-set diff
does not show metadata-only changes and reports "no differences" (the deploy still applies them; verified 2026-10-01).

## Behind an authenticating proxy

`publicUrl` should be the proxy's HTTPS address. If the proxy authenticates people but cannot tell Breadboard who they
are, and its audience is one person, `-c trustedProxyUser=<handle>` removes the second sign-in:

- The stack generates a secret (output `TrustedProxySecretArn`). The proxy must send its value in the header named by
  `TrustedProxyHeader` (`x-breadboard-proxy-auth`) on every request, including WebSocket upgrades.
- `breadboard-apply` reads the secret with the instance role and writes it to `/etc/breadboard/overrides.env` (root
  only). It never appears in the template or on a command line.
- Requests that carry it sign in as `<handle>`, an admin created on first use. Requests that bypass the proxy (the SSM
  tunnel, tool sandboxes) get no trust and still need a token. With an admin path in place, `bootstrapAdmin=false`
  becomes safe; keep the tunnel's break-glass in mind (`bootstrapAdmin=true` again).
- Never widen the proxy's audience while this is on: everyone it lets through becomes `<handle>`.

To rotate the secret, redeploy with a different `trustedProxyUser`, or turn it off and on again (each creates a new
secret), then redeploy the proxy.

## Behind an Application Load Balancer with OIDC

An Application Load Balancer can authenticate users itself: an HTTPS listener rule with an `authenticate-oidc` action
signs people in with your IdP and forwards each request with their claims in `x-amzn-oidc-data`, a JWT it signs. With
`-c albAuthArn=<load balancer ARN>`, the server verifies that header on every request (signature against the
load balancer's regional public key, `signer` equal to the ARN, expiry) and signs the request in as its `sub`. Users
are created at first sign-in as members; promote admins in Admin. Unlike the trusted proxy this tells people apart, so
it suits a team. Optionally pin `-c albAuthIssuer=<issuer URL>` and `-c albAuthClientId=<client id>` as well.

- The load balancer must be the only way to the server port: `allowedCidrs=none` and one ingress rule from its
  security group (synth warns otherwise). A forged header fails verification, but a genuine one could be replayed
  for its short lifetime by anyone who can reach the port directly.
- Use `onUnauthenticatedRequest: deny` for `/api/*` and `authenticate` for everything else. The UI treats the
  load balancer's non-JSON 401 (or its redirect) like any expired edge session and reloads the page through sign-in.
- Requests with an `Origin` naming another site get no edge identity, so the load balancer's cookies cannot be used by
  other pages. The SSM tunnel carries no header and still needs a token.
- Moving from `trustedProxyUser`: deploy `albAuthArn` together with `-c oidcAdoptHandles=<handle>`, so the proxy user's
  first sign-in through the load balancer becomes that same user (id, admin flag, history) instead of `<handle>-xxxxxx`.
  Startup warns when this is missing. Drop both `trustedProxyUser` and `oidcAdoptHandles` once the proxy is gone.

## AWS APIs from tools

Tools reach AWS APIs through the credential broker's `aws-role` kind ([12](../../specs/12-security-deployment.md) §5): no keys are stored in Breadboard; the broker signs each brokered request as a role the server assumes.

1. Create a role whose trust policy names the `ServerRoleArn` output, with the permissions the tools need.
2. Deploy with `-c brokerRoleArns=<role ARN>[,<role ARN>…]` (plus the usual `-c` set). This only changes the instance role's policy.
3. In Admin → Credential broker, add a credential of kind `aws-role` per AWS service the tools call, e.g. `{"region": "us-east-1", "service": "athena", "role_arn": "<role ARN>"}`, and a capability per credential scoped to the service endpoint (e.g. `athena.us-east-1.amazonaws.com`, method `POST`). Most AWS APIs are POST, so tools declare a scope other than `read` for these capabilities.

The same role can authenticate a repository mirror of an AWS CodeCommit repository ([06](../../specs/06-toolbox.md) §7.1):
1. Grant the role `codecommit:GitPull` on the repository.
2. Add an `aws-role` credential with `service: codecommit` in the repository's region.
3. Add a capability with host `git-codecommit.<region>.amazonaws.com`, methods `GET` and `POST`, and path prefix `/v1/repos/<name>/`.
4. Name that capability in `breadboard.yaml` `repos[].capability`.

The server fetches directly, not through the sandbox egress proxy, so the host needs outbound HTTPS to that endpoint. Mirrors live under `/var/breadboard/mirrors` on the root volume.

## Outputs

| Output | |
|---|---|
| `ServerUrl`, `ServerIp` | `publicUrl` when set, else the instance address. |
| `RdsEndpoint` | |
| `DbSecretArn`, `TokenSigningKeySecretArn`, `BrokerMasterKeySecretArn`, `AdminTokenSecretArn` | See Secrets. |
| `ObjectsBucket` | When `enableS3Objects` is true. |
| `TrustedProxySecretArn`, `TrustedProxyHeader`, `TrustedProxyUser` | With `trustedProxyUser`: what the proxy sends (see Behind an authenticating proxy). |
| `AlbAuthArn` | With `albAuthArn`: the load balancer the server trusts (see Behind an Application Load Balancer with OIDC). |
| `ServerRoleArn` | The instance role: what roles in `brokerRoleArns` must trust. |
| `ServerInstanceId`, `ServerSecurityGroupId`, `ServerPrivateDnsName`, `ServerPort`, `VpcId`, `ServerSubnetId` | For add-ons that front the server, such as a CloudFront distribution with a VPC origin to the instance. Plain outputs, not exports, so nothing can pin the stack. An add-on that adds an ingress rule to the server security group must be redeployed if this stack ever replaces the instance. |

## Behaviour to know about

- **The AMI is pinned on first synth** (`cdk.context.json`). A new AMI would replace the host, and the config repo lives on the host's root volume at `/var/breadboard`. To move to a newer AMI on purpose, mirror the config repo first (see Backup/DR), then run `npx cdk context --reset <key>`. A new subnet or root volume size replaces it too.
- **A user data change restarts the host; it does not replace it.** The root volume is EBS, so CloudFormation stops the instance, sets the new user data and starts it again: same instance id, private IP and root volume (with the config repo), a new public IP, a few minutes down. CDK's diff still says "may cause replacement". The new script does not run on the existing host (it runs once per instance), so settings that must reach existing hosts belong in the deployment metadata.
- **RDS modifications** made through a deploy apply during the deploy, not in the maintenance window; CloudFormation has no way to defer them. Verified 2026-10-01: `-c dbInstanceClass=db.t4g.large` on a single-AZ instance took 6.5 minutes and restarted the DB twice (about 30 s of unavailability); the server reconnected on its own. Use `dbMultiAz=true` or schedule such changes.
- **Destroy keeps the state.** `npx cdk destroy` leaves a final DB snapshot, all four secrets, and the objects bucket (`DeletionPolicy: RetainExceptOnCreate`, so a failed *first* deploy rolls back completely and can simply be retried). Deletion protection blocks a destroy, so first deploy with `-c dbDeletionProtection=false`. The retained secrets and bucket keep their names, so a new deploy with the same `name` fails until you delete them.

The server reaches Postgres only through `DATABASE_URL` (+ `DATABASE_SSL=require`, `DATABASE_IAM_AUTH=true`); any other managed Postgres works identically through the same seam. The bundled `deploy/compose.yaml` local-Postgres profile remains the dev/quickstart path.

Backup/DR: RDS snapshots + PITR replace self-managed archiving; mirror the config repo (`/var/breadboard/config-repo`, a plain bare git repo) to a remote; the objects bucket is versioned. See `docs/self-hosting.md` for the restore runbook.
