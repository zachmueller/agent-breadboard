variable "name" {
  description = "Short name of this Breadboard (one deployment = one Breadboard)."
  type        = string
}
variable "region" {
  type    = string
  default = "us-east-1"
}
variable "vpc_id" {
  type = string
}
variable "db_subnet_ids" {
  description = "Private subnets for RDS (>= 2 AZs)."
  type        = list(string)
}
variable "server_subnet_id" {
  type = string
}
variable "server_public_ip" {
  type    = bool
  default = true
}
variable "allowed_cidrs" {
  description = "CIDRs allowed to reach the server port."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
variable "server_port" {
  type    = number
  default = 4000
}
variable "server_instance_type" {
  type    = string
  default = "t3.large"
}
variable "server_root_volume_gb" {
  type    = number
  default = 100
}
variable "server_image" {
  description = "Container image for the Breadboard server (push the Dockerfile build to ECR and reference it here)."
  type        = string
}
variable "public_url" {
  description = "Externally reachable base URL (leave empty to use the instance IP)."
  type        = string
  default     = ""
}
variable "sandbox_runner" {
  description = "docker (recommended) or process."
  type        = string
  default     = "docker"
}
variable "db_engine_version" {
  type    = string
  default = "16"
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}
variable "db_max_allocated_storage_gb" {
  type    = number
  default = 500
}
variable "db_multi_az" {
  type    = bool
  default = false
}
variable "db_backup_retention_days" {
  type    = number
  default = 14
}
variable "db_deletion_protection" {
  type    = bool
  default = true
}
variable "enable_s3_objects" {
  description = "Use an S3 bucket for large blobs instead of the host filesystem."
  type        = bool
  default     = true
}
variable "tags" {
  type    = map(string)
  default = {}
}
