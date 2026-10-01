output "server_public_ip" {
  value = aws_instance.server.public_ip
}
output "server_url" {
  value = var.public_url != "" ? var.public_url : "http://${aws_instance.server.public_ip}:${var.server_port}"
}
output "rds_endpoint" {
  value = aws_db_instance.db.address
}
output "secret_arn" {
  description = "Secrets Manager secret holding DATABASE_URL, TOKEN_SIGNING_KEY, BROKER_MASTER_KEY."
  value       = aws_secretsmanager_secret.app.arn
}
output "objects_bucket" {
  value = var.enable_s3_objects ? aws_s3_bucket.objects[0].bucket : null
}
