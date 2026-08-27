output "site_url" {
  description = "The distribution's own endpoint. Always works, whatever aliases are set."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "custom_urls" {
  description = "Configured hostnames. Each needs a DNS record pointing at distribution_domain."
  value       = [for a in var.aliases : "https://${a}"]
}

output "distribution_domain" {
  description = "CNAME target for every hostname in custom_urls."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "distribution_id" {
  description = "Needed by `aws cloudfront associate-alias` when moving a hostname here."
  value       = aws_cloudfront_distribution.site.id
}

output "bucket_name" {
  description = "Set as the S3_BUCKET repository variable."
  value       = aws_s3_bucket.site.id
}

output "deploy_role_arn" {
  description = "Set as the AWS_ROLE_ARN repository secret."
  value       = aws_iam_role.deploy.arn
}

output "region" {
  description = "Set as the AWS_REGION repository variable."
  value       = var.region
}

output "github_configuration" {
  description = "Everything to configure on the repository side."
  value       = <<-EOT

    Repository secrets (Settings -> Secrets and variables -> Actions):
      AWS_ROLE_ARN          ${aws_iam_role.deploy.arn}
      SEMERG_ENTSOE_TOKEN   (your Entso-E web API token)
      SEMERG_FINGRID_TOKEN  (your Fingrid API key)

    Repository variables:
      AWS_REGION            ${var.region}
      S3_BUCKET             ${aws_s3_bucket.site.id}

    Then visit https://${aws_cloudfront_distribution.site.domain_name}
  EOT
}
