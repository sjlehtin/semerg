resource "aws_s3_bucket" "site" {
  bucket = var.bucket_name
}

# CloudFront reaches the bucket through an Origin Access Control, so nothing
# needs to be publicly readable.
resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  # Deliberately NOT expiring old hashed bundles by age.
  #
  # It is tempting: the deploy sync omits --delete on purpose, so superseded
  # bundles accumulate. But every asset is content-hashed, which means each
  # deploy writes new keys rather than new versions -- so noncurrent-version
  # expiry does not apply -- and an age-based rule cannot tell the live bundle
  # from a dead one. Deploys here are infrequent, so before long the *current*
  # bundle is the oldest object under assets/ and would be the first thing
  # deleted, taking the site down.
  #
  # Pruning happens at deploy time instead, where it is safe because the
  # bundle index.html references was just written and is known. See
  # .github/workflows/deploy-site.yml.
  #
  # The cost of keeping everything is trivial: a few hundred kB per deploy.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid    = "AllowCloudFrontRead"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    # Scopes the grant to this one distribution rather than to the CloudFront
    # service as a whole.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }

  # Nothing here reaches the bucket over plain HTTP today -- CloudFront signs
  # with SigV4 over TLS, and the CLI uses HTTPS -- but S3 would still accept it.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.site.arn,
      "${aws_s3_bucket.site.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}
