# Lets GitHub Actions assume a role by presenting a signed workflow token,
# rather than storing long-lived AWS access keys in the repository.

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # thumbprint_list is deliberately omitted: it is optional in AWS provider 5.x
  # and AWS ignores it for this provider, verifying token.actions.
  # githubusercontent.com against its own trust store instead. Pinning a
  # thumbprint here would only create something to maintain that nothing reads.
}

data "aws_iam_openid_connect_provider" "existing" {
  count = var.create_oidc_provider ? 0 : 1

  url = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? (
    aws_iam_openid_connect_provider.github[0].arn
    ) : (
    data.aws_iam_openid_connect_provider.existing[0].arn
  )

  allowed_subjects = [
    for ref in var.allowed_git_refs :
    "repo:${var.github_repository}:ref:${ref}"
  ]
}

data "aws_iam_policy_document" "assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Pinned to specific refs. Without this condition -- or with a wildcard
    # subject -- any workflow in the repository, including one from a pull
    # request opened by a stranger, could assume this role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.allowed_subjects
    }

    # The subject above is built from *names*, and names are reassignable: if
    # the account were ever renamed or deleted, whoever claimed the username
    # could create a repository that satisfies it exactly. The owner ID is
    # permanent, so asserting it closes that off.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_owner_id"
      values   = [var.github_owner_id]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "semerg-deploy"
  description        = "Assumed by semerg's GitHub Actions workflows to publish the site"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
}

data "aws_iam_policy_document" "deploy" {
  # Note the two different resource shapes: s3:ListBucket acts on the bucket
  # itself, object actions need the /* suffix. A policy granting object actions
  # on the bare bucket ARN grants nothing at all.
  statement {
    sid       = "ListTheBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]
  }

  statement {
    sid    = "ReadWriteObjects"
    effect = "Allow"
    actions = [
      # sync compares against what is already there, and refresh-data
      # downloads the published data.json to check it is not regressing.
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.site.arn}/*"]
  }

  # Deletion is confined to hashed bundles. The only thing that deletes is the
  # prune step in deploy-site.yml, and it only ever touches assets/. Scoping it
  # here means a compromised workflow cannot remove index.html or data.json --
  # i.e. cannot blank the site, only cost it a rebuild.
  #
  # s3:PutObjectAcl is deliberately absent: the bucket is BucketOwnerEnforced,
  # so ACLs do not exist and granting it would be pure surface.
  statement {
    sid       = "PruneSupersededAssets"
    effect    = "Allow"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.site.arn}/assets/*"]
  }

  # No CloudFront permissions, deliberately: freshness comes from Cache-Control
  # rather than invalidations. And no access to the old bucket, which makes the
  # parallel-running old service structurally safe rather than safe by care.
}

resource "aws_iam_role_policy" "deploy" {
  name   = "semerg-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
