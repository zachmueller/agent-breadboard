# AWS reference deployment

A TypeScript CDK app that provisions the recommended production shape from [12 — Security & Deployment](../../specs/12-security-deployment.md) §1:

- **RDS Postgres 16** (encrypted, private, forced SSL, IAM auth enabled, automated snapshots + PITR). This is the only required stateful dependency.
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
| `publicUrl` | instance IP | Externally reachable base URL. When empty, the bootstrap script resolves the instance IP from IMDS. |
| `sandboxRunner` | `docker` | `docker` or `process`. |
| `dbEngineVersion` | `16` | |
| `dbInstanceClass` | `db.t4g.medium` | |
| `dbAllocatedStorageGb` / `dbMaxAllocatedStorageGb` | `50` / `500` | |
| `dbMultiAz` | `false` | |
| `dbBackupRetentionDays` | `14` | |
| `dbDeletionProtection` | `true` | |
| `enableS3Objects` | `true` | When false, blobs go to the host filesystem under `/var/breadboard`. |
| `tags` | none | Extra tags, e.g. `Team=research,CostCenter=1234`. `Project` and `Breadboard` are always set. |

## Secrets

Secrets Manager generates all four secrets, so their values never appear in the template, in CDK output, or on the deployer's machine:

- `breadboard-<name>/db`: RDS credentials (`username`, `password`). The bootstrap script builds `DATABASE_URL` from these plus the RDS endpoint.
- `breadboard-<name>/token-signing-key`: `TOKEN_SIGNING_KEY`.
- `breadboard-<name>/broker-master-key`: `BROKER_MASTER_KEY`. 43 alphanumeric characters, which decode as base64 to exactly 32 bytes.
- `breadboard-<name>/admin-token`: `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN`, the break-glass sign-in for `bootstrap-admin` (see First sign-in).

## First sign-in

The image runs with `NODE_ENV=production`, which refuses the seed's well-known `*-change-me` tokens. Sign in with the
generated bootstrap admin token, then switch `auth.mode` to OIDC (or set real local tokens) and deactivate
`bootstrap-admin` in Admin:

```bash
aws secretsmanager get-secret-value --secret-id breadboard-<name>/admin-token --query SecretString --output text
```

## Upgrading the server

Deploy with a new image tag: `npx cdk deploy … -c serverImage=$R:server-v0.2` (same for the sandbox images). The images
live in the instance's CloudFormation::Init metadata, not in its user data, so the deploy neither restarts nor replaces
the host. cfn-hup on the host notices the metadata change within a minute or two, pulls the images, and recreates the
`breadboard` container (`/usr/local/bin/breadboard-apply`; log in `/var/log/cfn-hup.log`). The config repo on
`/var/breadboard` is untouched.

## Behaviour to know about

- **The AMI is pinned on first synth** (`cdk.context.json`). A new AMI would replace the host, and the config repo lives on the host's root volume at `/var/breadboard`. To move to a newer AMI on purpose, mirror the config repo first (see Backup/DR), then run `npx cdk context --reset <key>`.
- **RDS modifications** made through a deploy (for example, a new instance class) are expected to apply during the deploy rather than in the maintenance window. CloudFormation has no equivalent of deferring them. This is not yet confirmed; see `docs/verification-plan.md` §7.
- **Destroy keeps the state.** `npx cdk destroy` leaves a final DB snapshot, all four secrets, and the objects bucket (`DeletionPolicy: RetainExceptOnCreate`, so a failed *first* deploy rolls back completely and can simply be retried). Deletion protection blocks a destroy, so first deploy with `-c dbDeletionProtection=false`. The retained secrets and bucket keep their names, so a new deploy with the same `name` fails until you delete them.

The server reaches Postgres only through `DATABASE_URL` (+ `DATABASE_SSL=require`); any other managed Postgres works identically through the same seam. The bundled `deploy/compose.yaml` local-Postgres profile remains the dev/quickstart path.

Backup/DR: RDS snapshots + PITR replace self-managed archiving; mirror the config repo (`/var/breadboard/config-repo`, a plain bare git repo) to a remote; the objects bucket is versioned. See `docs/self-hosting.md` for the restore runbook.
