# GitHub Actions deploys with short-lived credentials from OIDC. No AWS keys are stored in GitHub.
locals {
  github_enabled = var.github_repo != ""
  oidc_url       = "token.actions.githubusercontent.com"
  gh_owner       = split("/", var.github_repo)[0]
  gh_repo        = try(split("/", var.github_repo)[1], "")
  oidc_arn = local.github_enabled ? (
    var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn :
    "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:oidc-provider/${local.oidc_url}"
  ) : ""
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = local.github_enabled && var.create_github_oidc_provider ? 1 : 0
  url             = "https://${local.oidc_url}"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
}

data "aws_iam_policy_document" "github_assume" {
  count = local.github_enabled ? 1 : 0
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "${local.oidc_url}:sub"
      # GitHub sends either the classic subject or the newer one with immutable owner/repo ids
      # ("repo:owner@123/name@456:..."), so both forms are accepted.
      values = [
        "repo:${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_repo}:environment:production",
        "repo:${local.gh_owner}@*/${local.gh_repo}@*:ref:refs/heads/main",
        "repo:${local.gh_owner}@*/${local.gh_repo}@*:environment:production",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count              = local.github_enabled ? 1 : 0
  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume[0].json
}

data "aws_iam_policy_document" "github_deploy" {
  count = local.github_enabled ? 1 : 0
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid       = "RollInstances"
    actions   = ["autoscaling:StartInstanceRefresh"]
    resources = [aws_autoscaling_group.app.arn]
  }
  statement {
    sid       = "WatchRollout"
    actions   = ["autoscaling:DescribeInstanceRefreshes", "autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"]
  }
  statement {
    sid       = "Lambdas"
    actions   = ["lambda:UpdateFunctionCode", "lambda:GetFunction"]
    resources = [for f in aws_lambda_function.fn : f.arn]
  }
  statement {
    sid       = "FrontendList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.frontend.arn]
  }
  statement {
    sid       = "FrontendWrite"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
  }
  statement {
    sid       = "Invalidate"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.main.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count  = local.github_enabled ? 1 : 0
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}
