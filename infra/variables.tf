variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "sharebox"
}

variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "alert_email" {
  description = "Email for CloudWatch alarms and budget alerts (you must confirm the SNS subscription email). Leave empty to skip."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "AWS Budgets monthly limit. Alerts at 50% and 80% actual and 100% forecasted."
  type        = number
  default     = 25
}

variable "private_instances" {
  description = <<-EOT
    true  = EC2 in private subnets with no internet route. ECR/CloudWatch Logs are reached through
            VPC interface endpoints (about $0.03/hour for 3 endpoints in one AZ). S3 and DynamoDB use free gateway endpoints.
    false = EC2 in public subnets with public IPs (cheaper, about $0.01/hour for 2 IPs), still only reachable from the ALB.
    Neither option uses a NAT Gateway.
  EOT
  type        = bool
  default     = true
}

variable "instance_type" {
  description = "EC2 instance type for the API (t3.micro is free-tier eligible)."
  type        = string
  default     = "t3.micro"
}

variable "asg_min" {
  type    = number
  default = 1
}

variable "asg_desired" {
  description = "2 spreads one instance per AZ (high availability). Set 1 to halve EC2 cost."
  type        = number
  default     = 2
}

variable "asg_max" {
  type    = number
  default = 3
}

variable "image_tag" {
  description = "Docker image tag the launch template runs. CI pushes :latest and :<git sha>."
  type        = string
  default     = "latest"
}

variable "github_repo" {
  description = "owner/name of the GitHub repo allowed to deploy through OIDC (no long-lived keys). Empty disables it."
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  description = "Set false if your account already has the token.actions.githubusercontent.com OIDC provider."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 14
}
