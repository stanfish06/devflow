output "instance_id" {
  value = aws_instance.devflow.id
}

output "region" {
  value = var.region
}

output "bundle_bucket" {
  value = aws_s3_bucket.bundles.id
}

output "next_steps" {
  value = <<-EOT
    1. Store the Claude Code token (other keys go under ${var.ssm_path}/ the same way):
       aws ssm put-parameter --region ${var.region} --name ${var.ssm_path}/CLAUDE_CODE_OAUTH_TOKEN --type SecureString --overwrite --value "$CLAUDE_CODE_OAUTH_TOKEN"
    2. Upload the code and start devflow on the instance:
       bun run devflow aws push --instance ${aws_instance.devflow.id} --bucket ${aws_s3_bucket.bundles.id} --region ${var.region}
    3. Open a tunnel to the UI:
       bun run devflow aws tunnel --instance ${aws_instance.devflow.id} --region ${var.region}
  EOT
}
