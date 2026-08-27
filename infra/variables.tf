variable "region" {
  description = "Region for the S3 bucket. CloudFront itself is global."
  type        = string
  default     = "eu-north-1"
}

variable "bucket_name" {
  description = "Name of the new site bucket. Must not be the existing live bucket."
  type        = string
  default     = "semeai-energy-v2"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the deployment role."
  type        = string
  default     = "sjlehtin/semerg"
}

variable "github_owner_id" {
  description = <<-EOT
    Numeric GitHub account ID of the repository owner.

    Asserted in the trust policy alongside the subject, because the subject is
    built from names and names can be reassigned. Find it with:
      curl -s https://api.github.com/users/<login> | jq .id
  EOT
  type        = string
  default     = "417723"
}

variable "allowed_git_refs" {
  description = <<-EOT
    Git refs whose workflow runs may assume the deployment role.

    Deliberately not "repo:owner/repo:*", which matches every branch, tag and
    pull-request context -- far too much surface for a role that can delete
    objects, on a public repository where anyone can open a pull request.

    To run a workflow from a branch during setup, add its ref here temporarily
    and remove it afterwards.
  EOT
  type        = list(string)
  default     = ["refs/heads/main"]
}

variable "create_oidc_provider" {
  description = <<-EOT
    Whether to create the GitHub OIDC provider.

    An AWS account can only have one provider per URL. Set this to false if
    another project already added token.actions.githubusercontent.com to this
    account, and the existing one will be looked up instead.
  EOT
  type        = bool
  default     = true
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 is North America and Europe, which covers a Finnish audience at the lowest cost."
  type        = string
  default     = "PriceClass_100"
}
