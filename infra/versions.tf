terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.80" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    archive = { source = "hashicorp/archive", version = "~> 2.6" }
    http    = { source = "hashicorp/http", version = "~> 3.4" }
  }
  # Local state keeps setup to one command. For a team, move it to S3 with native locking:
  # backend "s3" { bucket = "<state-bucket>" key = "sharebox/terraform.tfstate" region = "us-east-1" use_lockfile = true }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Repo      = "fileshare-aws"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  name       = var.project
  account_id = data.aws_caller_identity.current.account_id
  suffix     = random_string.suffix.result
}
