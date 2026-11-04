# Four small Lambdas, each with its own least-privilege role. Code is bundled by `npm run build:lambdas`.
locals {
  lambda_env = {
    TABLE_NAME   = aws_dynamodb_table.files.name
    FILES_BUCKET = aws_s3_bucket.files.id
    NODE_OPTIONS = "--enable-source-maps"
  }

  lambdas = {
    share-api = {
      description = "Public share links: file info + presigned download (API Gateway)"
      timeout     = 10
      memory      = 256
      statements = [
        { actions = ["dynamodb:GetItem", "dynamodb:UpdateItem"], resources = [aws_dynamodb_table.files.arn] },
        { actions = ["s3:GetObject"], resources = ["${aws_s3_bucket.files.arn}/uploads/*"] },
      ]
    }
    process-upload = {
      description = "S3 ObjectCreated (via SQS): mark uploads ready, remove orphans"
      timeout     = 30
      memory      = 256
      statements = [
        { actions = ["dynamodb:GetItem", "dynamodb:UpdateItem"], resources = [aws_dynamodb_table.files.arn] },
        { actions = ["s3:DeleteObject"], resources = ["${aws_s3_bucket.files.arn}/uploads/*"] },
        { actions = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], resources = [aws_sqs_queue.upload_events.arn] },
      ]
    }
    expiry-stream = {
      description = "DynamoDB TTL REMOVE events (via Streams): delete the S3 object"
      timeout     = 30
      memory      = 256
      statements = [
        { actions = ["s3:DeleteObject"], resources = ["${aws_s3_bucket.files.arn}/uploads/*"] },
        { actions = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"], resources = [aws_dynamodb_table.files.stream_arn] },
      ]
    }
    sweeper = {
      description = "Every 15 minutes (EventBridge Scheduler): delete expired files on time"
      timeout     = 120
      memory      = 256
      statements = [
        { actions = ["dynamodb:Scan", "dynamodb:DeleteItem"], resources = [aws_dynamodb_table.files.arn] },
        { actions = ["s3:DeleteObject"], resources = ["${aws_s3_bucket.files.arn}/uploads/*"] },
      ]
    }
  }
}

data "archive_file" "lambda" {
  for_each    = local.lambdas
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/dist/${each.key}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  for_each           = local.lambdas
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda" {
  for_each = local.lambdas
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda[each.key].arn}:*"]
  }
  dynamic "statement" {
    for_each = each.value.statements
    content {
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  for_each = local.lambdas
  role     = aws_iam_role.lambda[each.key].id
  policy   = data.aws_iam_policy_document.lambda[each.key].json
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.lambdas
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "fn" {
  for_each         = local.lambdas
  function_name    = "${local.name}-${each.key}"
  description      = each.value.description
  role             = aws_iam_role.lambda[each.key].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"] # Graviton: ~20% cheaper per GB-second
  handler          = "index.handler"
  filename         = data.archive_file.lambda[each.key].output_path
  source_code_hash = data.archive_file.lambda[each.key].output_base64sha256
  timeout          = each.value.timeout
  memory_size      = each.value.memory
  environment { variables = local.lambda_env }
  tracing_config { mode = "Active" } # X-Ray traces
  depends_on = [aws_iam_role_policy.lambda, aws_cloudwatch_log_group.lambda]
}

resource "aws_iam_role_policy_attachment" "lambda_xray" {
  for_each   = local.lambdas
  role       = aws_iam_role.lambda[each.key].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# ---- Triggers ----
resource "aws_lambda_event_source_mapping" "upload_events" {
  event_source_arn                   = aws_sqs_queue.upload_events.arn
  function_name                      = aws_lambda_function.fn["process-upload"].arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]
}

resource "aws_lambda_event_source_mapping" "expiry_stream" {
  event_source_arn               = aws_dynamodb_table.files.stream_arn
  function_name                  = aws_lambda_function.fn["expiry-stream"].arn
  starting_position              = "LATEST"
  batch_size                     = 100
  maximum_retry_attempts         = 5
  bisect_batch_on_function_error = true
  function_response_types        = ["ReportBatchItemFailures"]
  filter_criteria {
    filter {
      pattern = jsonencode({ eventName = ["REMOVE"] }) # only deletions invoke the function
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "scheduler.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.fn["sweeper"].arn }]
  })
}

resource "aws_scheduler_schedule" "sweeper" {
  name                = "${local.name}-sweeper"
  schedule_expression = "rate(15 minutes)"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.fn["sweeper"].arn
    role_arn = aws_iam_role.scheduler.arn
    retry_policy { maximum_retry_attempts = 2 }
  }
}
