# Agent Breadboard — AWS reference deployment ([12] §1, §9): RDS Postgres (recommended production default)
# + one reference server host running the container image. One deployment = one Breadboard ([00] §4.1).
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

provider "aws" {
  region = var.region
}

locals {
  name = "breadboard-${var.name}"
  tags = merge({ Project = "agent-breadboard", Breadboard = var.name }, var.tags)
}

data "aws_caller_identity" "current" {}

# --- Network --------------------------------------------------------------
data "aws_vpc" "selected" {
  id = var.vpc_id
}

resource "aws_security_group" "server" {
  name        = "${local.name}-server"
  description = "Breadboard server host"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    description = "HTTP(S) to the Breadboard server"
    from_port   = var.server_port
    to_port     = var.server_port
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Breadboard Postgres"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    description     = "Postgres from the server host only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.server.id]
  }
}

# --- RDS Postgres (the only required stateful dependency) ------------------
resource "aws_db_subnet_group" "db" {
  name       = "${local.name}-db"
  subnet_ids = var.db_subnet_ids
  tags       = local.tags
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_parameter_group" "db" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  tags   = local.tags
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "db" {
  identifier                          = "${local.name}-db"
  engine                              = "postgres"
  engine_version                      = var.db_engine_version
  instance_class                      = var.db_instance_class
  allocated_storage                   = var.db_allocated_storage_gb
  max_allocated_storage               = var.db_max_allocated_storage_gb
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_name                             = "breadboard"
  username                            = "breadboard"
  password                            = random_password.db.result
  iam_database_authentication_enabled = true
  db_subnet_group_name                = aws_db_subnet_group.db.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  parameter_group_name                = aws_db_parameter_group.db.name
  multi_az                            = var.db_multi_az
  backup_retention_period             = var.db_backup_retention_days # automated snapshots + PITR ([12] §1 backup/DR)
  deletion_protection                 = var.db_deletion_protection
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${local.name}-final"
  performance_insights_enabled        = true
  publicly_accessible                 = false
  apply_immediately                   = false
  tags                                = local.tags
}

# --- Secrets ---------------------------------------------------------------
resource "aws_secretsmanager_secret" "app" {
  name = "${local.name}/app"
  tags = local.tags
}

resource "random_password" "token_key" {
  length  = 48
  special = false
}
resource "random_bytes" "broker_key" {
  length = 32
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL      = "postgres://breadboard:${random_password.db.result}@${aws_db_instance.db.address}:5432/breadboard"
    TOKEN_SIGNING_KEY = random_password.token_key.result
    BROKER_MASTER_KEY = random_bytes.broker_key.base64
  })
}

# --- Object storage (optional S3-compatible) --------------------------------
resource "aws_s3_bucket" "objects" {
  count         = var.enable_s3_objects ? 1 : 0
  bucket        = "${local.name}-objects-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
  tags          = local.tags
}
resource "aws_s3_bucket_versioning" "objects" {
  count  = var.enable_s3_objects ? 1 : 0
  bucket = aws_s3_bucket.objects[0].id
  versioning_configuration { status = "Enabled" }
}

# --- Server host (reference: one EC2 instance running the container) ----------
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }
}

resource "aws_iam_role" "server" {
  name = "${local.name}-server"
  tags = local.tags
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "server" {
  name = "${local.name}-server"
  role = aws_iam_role.server.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"], Resource = "*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.app.arn },
      { Effect = "Allow", Action = ["rds-db:connect"], Resource = "arn:aws:rds-db:${var.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.db.resource_id}/breadboard" },
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "*" }
      ], var.enable_s3_objects ? [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:HeadObject", "s3:ListBucket"], Resource = [aws_s3_bucket.objects[0].arn, "${aws_s3_bucket.objects[0].arn}/*"] }
    ] : [])
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "server" {
  name = "${local.name}-server"
  role = aws_iam_role.server.name
}

resource "aws_instance" "server" {
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.server_instance_type
  subnet_id                   = var.server_subnet_id
  vpc_security_group_ids      = [aws_security_group.server.id]
  iam_instance_profile        = aws_iam_instance_profile.server.name
  associate_public_ip_address = var.server_public_ip
  tags                        = merge(local.tags, { Name = "${local.name}-server" })

  root_block_device {
    volume_size = var.server_root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    image            = var.server_image
    region           = var.region
    secret_arn       = aws_secretsmanager_secret.app.arn
    public_url       = var.public_url != "" ? var.public_url : "http://${local.aws_instance_placeholder_ip}:${var.server_port}"
    server_port      = var.server_port
    object_store     = var.enable_s3_objects ? "s3" : "fs"
    s3_bucket        = var.enable_s3_objects ? aws_s3_bucket.objects[0].bucket : ""
    sandbox_runner   = var.sandbox_runner
    model_provider   = "bedrock"
  })
}

# Terraform cannot reference the instance's own IP inside its user_data; use a stable placeholder that the
# bootstrap script resolves at runtime via IMDS when `public_url` is left empty.
locals {
  aws_instance_placeholder_ip = "__IMDS__"
}
