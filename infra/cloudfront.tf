resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.bucket_name}-oac"
  description                       = "Origin access control for the semerg site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Respects the Cache-Control headers the deploy workflows set on each object,
# which is where this site's caching policy actually lives: hashed assets are
# immutable, index.html and data.json get a 60 second TTL. See
# docs/deployment.md.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# Security headers the origin cannot set for itself: these apply to every
# response, including ones served from cache.
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.bucket_name}-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
      # No includeSubDomains while on *.cloudfront.net: that hostname is a
      # shared domain and the header should not speak for anything but this
      # distribution. Revisit when a custom domain is in place.
      include_subdomains = false
      preload            = false
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

data "aws_acm_certificate" "site" {
  count    = length(var.aliases) > 0 ? 1 : 0
  provider = aws.us_east_1

  domain      = var.certificate_domain
  statuses    = ["ISSUED"]
  most_recent = true
}

resource "aws_cloudfront_distribution" "site" {
  enabled         = true
  comment         = "semerg static site"
  price_class     = var.price_class
  http_version    = "http2and3"
  is_ipv6_enabled = true

  # Without this, a request for / returns an S3 AccessDenied XML document
  # rather than the page -- which looks like a permissions problem and is not.
  default_root_object = "index.html"

  aliases = var.aliases

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "site-bucket"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "site-bucket"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id

    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Only looked up when a custom hostname is actually configured, so the
  # default *.cloudfront.net setup needs no certificate to exist.
  dynamic "viewer_certificate" {
    for_each = length(var.aliases) > 0 ? [1] : []
    content {
      acm_certificate_arn = data.aws_acm_certificate.site[0].arn
      ssl_support_method  = "sni-only"

      # Only reachable with a custom certificate. The default
      # *.cloudfront.net one pins the distribution to CloudFront's "TLSv1"
      # policy, which still permits TLS 1.0 and 1.1 and 3DES ciphers, and
      # rejects this argument outright.
      minimum_protocol_version = "TLSv1.2_2021"
    }
  }

  dynamic "viewer_certificate" {
    for_each = length(var.aliases) > 0 ? [] : [1]
    content {
      cloudfront_default_certificate = true
    }
  }
}
