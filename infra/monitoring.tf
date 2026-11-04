# ---------------- Alarms -> SNS -> email ----------------
locals {
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "API instances are returning 5xx errors"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${local.name}-unhealthy-hosts"
  alarm_description   = "At least one API instance failed ALB health checks for 3 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.app.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = local.lambdas
  alarm_name          = "${local.name}-${each.key}-errors"
  alarm_description   = "Lambda ${each.key} is throwing errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.fn[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${local.name}-upload-events-dlq"
  alarm_description   = "Upload events failed 3 times and landed in the dead-letter queue"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.upload_events_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "apigw_5xx" {
  alarm_name          = "${local.name}-share-api-5xx"
  alarm_description   = "Public share API is returning 5xx errors"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.public.id, Stage = "$default" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# ---------------- Dashboard ----------------
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.name
  dashboard_body = jsonencode({
    widgets = [
      {
        type       = "text", x = 0, y = 0, width = 24, height = 2,
        properties = { markdown = "## ${local.name}\nCloudFront -> ALB -> EC2 (API) · API Gateway -> Lambda (share links) · S3 -> SQS -> Lambda (uploads) · DynamoDB TTL -> Streams -> Lambda (expiry)" }
      },
      {
        type = "metric", x = 0, y = 2, width = 8, height = 6,
        properties = {
          title = "ALB requests and errors", region = var.region, stat = "Sum", period = 60, view = "timeSeries",
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix],
            [".", "HTTPCode_Target_4XX_Count", ".", "."],
            [".", "HTTPCode_Target_5XX_Count", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 2, width = 8, height = 6,
        properties = {
          title = "API latency (p50 / p95)", region = var.region, period = 60, view = "timeSeries",
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix, { stat = "p50" }],
            ["...", { stat = "p95" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 2, width = 8, height = 6,
        properties = {
          title = "EC2 fleet", region = var.region, period = 60, view = "timeSeries",
          metrics = [
            ["AWS/EC2", "CPUUtilization", "AutoScalingGroupName", aws_autoscaling_group.app.name, { stat = "Average" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", aws_lb_target_group.app.arn_suffix, "LoadBalancer", aws_lb.main.arn_suffix, { stat = "Minimum", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 8, width = 8, height = 6,
        properties = {
          title   = "Lambda invocations", region = var.region, stat = "Sum", period = 300, view = "timeSeries",
          metrics = [for k in keys(local.lambdas) : ["AWS/Lambda", "Invocations", "FunctionName", "${local.name}-${k}"]]
        }
      },
      {
        type = "metric", x = 8, y = 8, width = 8, height = 6,
        properties = {
          title   = "Lambda errors", region = var.region, stat = "Sum", period = 300, view = "timeSeries",
          metrics = [for k in keys(local.lambdas) : ["AWS/Lambda", "Errors", "FunctionName", "${local.name}-${k}"]]
        }
      },
      {
        type = "metric", x = 16, y = 8, width = 8, height = 6,
        properties = {
          title = "Business metrics (EMF)", region = var.region, stat = "Sum", period = 300, view = "timeSeries",
          metrics = [
            ["FileShare", "FilesUploaded"],
            [".", "Downloads"],
            [".", "FilesSwept"],
            [".", "FilesExpiredByTtl"],
            [".", "WrongPasswordAttempts"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 14, width = 8, height = 6,
        properties = {
          title = "Upload event queue", region = var.region, stat = "Maximum", period = 60, view = "timeSeries",
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.upload_events.name],
            ["...", aws_sqs_queue.upload_events_dlq.name],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 14, width = 8, height = 6,
        properties = {
          title = "DynamoDB capacity used", region = var.region, stat = "Sum", period = 300, view = "timeSeries",
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.files.name],
            [".", "ConsumedWriteCapacityUnits", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 14, width = 8, height = 6,
        properties = {
          title = "Share API (API Gateway)", region = var.region, stat = "Sum", period = 300, view = "timeSeries",
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", aws_apigatewayv2_api.public.id, "Stage", "$default"],
            [".", "4xx", ".", ".", ".", "."],
            [".", "5xx", ".", ".", ".", "."],
          ]
        }
      },
    ]
  })
}

# ---------------- Budget ----------------
resource "aws_budgets_budget" "monthly" {
  count        = var.alert_email == "" ? 0 : 1
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [
      { threshold = 50, type = "ACTUAL" },
      { threshold = 80, type = "ACTUAL" },
      { threshold = 100, type = "FORECASTED" },
    ]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = [var.alert_email]
    }
  }
}
