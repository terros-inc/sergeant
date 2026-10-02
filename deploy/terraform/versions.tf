terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Partial: the bucket and region are the installation's, and its account the only one allowed, all
  # passed by init.sh. The key is fixed: a mistyped one would look like an empty first deployment.
  # `use_lockfile` is S3-native locking.
  backend "s3" {
    key          = "v2/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  # Credentials come from the environment (AWS_PROFILE); the wrong account fails here,
  # before anything is read or changed.
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project   = "sergeant"
      Component = "sergeant-v2"
      ManagedBy = "terraform"
    }
  }
}
