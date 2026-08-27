terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # State is local and gitignored. For a single operator, remote state's real
  # benefits -- locking and sharing -- do not apply, and this configuration is
  # small enough that `terraform import` is a cheap recovery path if the file
  # is lost. See infra/README.md.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "semerg"
      ManagedBy = "terraform"
    }
  }
}

# CloudFront only accepts certificates from us-east-1, wherever the bucket and
# the distribution itself happen to live.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "semerg"
      ManagedBy = "terraform"
    }
  }
}
