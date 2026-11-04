output "app_url" {
  description = "Open this in your browser."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "asg_name" {
  value = aws_autoscaling_group.app.name
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.id
}

output "files_bucket" {
  value = aws_s3_bucket.files.id
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "lambda_functions" {
  value = { for k, f in aws_lambda_function.fn : k => f.function_name }
}

output "cognito_hosted_ui" {
  value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
}

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN secret in GitHub."
  value       = local.github_enabled ? aws_iam_role.github_deploy[0].arn : null
}

output "region" {
  value = var.region
}
