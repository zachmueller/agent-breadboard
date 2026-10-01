# AWS reference deployment

Provisions the recommended production shape from [12 — Security & Deployment](../../specs/12-security-deployment.md) §1:

- **RDS Postgres 16** (encrypted, private, forced SSL, IAM auth enabled, automated snapshots + PITR) — the only required stateful dependency.
- **One reference server host** (EC2, Amazon Linux 2023) running the Breadboard container with Docker for the tool sandbox, Bedrock access via an instance role, and secrets from Secrets Manager.
- Optional **S3 bucket** (versioned) for large blobs.

```bash
# 1. Build and push the image
docker build -t <account>.dkr.ecr.<region>.amazonaws.com/agent-breadboard:v0.1 .
docker push <account>.dkr.ecr.<region>.amazonaws.com/agent-breadboard:v0.1

# 2. Apply
cd deploy/aws
terraform init
terraform apply -var name=myteam -var vpc_id=vpc-… -var 'db_subnet_ids=["subnet-a","subnet-b"]' \
  -var server_subnet_id=subnet-c -var server_image=<account>.dkr.ecr.<region>.amazonaws.com/agent-breadboard:v0.1
```

The server reaches Postgres only through `DATABASE_URL` (+ `DATABASE_SSL=require`); any other managed Postgres works identically through the same seam. The bundled `deploy/compose.yaml` local-Postgres profile remains the dev/quickstart path.

Backup/DR: RDS snapshots + PITR replace self-managed archiving; mirror the config repo (`/var/breadboard/config-repo`, a plain bare git repo) to a remote; the objects bucket is versioned. See `docs/self-hosting.md` for the restore runbook.
