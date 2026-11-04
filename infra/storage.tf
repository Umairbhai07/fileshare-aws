# ---------------- Files bucket: private, encrypted, auto-expiring ----------------
resource "aws_s3_bucket" "files" {
  bucket        = "${local.name}-files-${local.account_id}-${local.suffix}"
  force_destroy = true # lets `make destroy` remove a bucket that still has files
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Safety net: even if every Lambda failed, S3 itself deletes uploads after 1 day.
resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    id     = "expire-uploads"
    status = "Enabled"
    filter { prefix = "uploads/" }
    expiration { days = 1 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

# Browsers upload/download directly with presigned URLs, so the bucket needs CORS for our domain.
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = ["https://${aws_cloudfront_distribution.main.domain_name}", "http://localhost:8080"]
    allowed_headers = ["content-type", "content-length"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "files_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.files.arn, "${aws_s3_bucket.files.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "files" {
  bucket     = aws_s3_bucket.files.id
  policy     = data.aws_iam_policy_document.files_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.files]
}

# ---------------- S3 event -> SQS (+DLQ) -> Lambda ----------------
resource "aws_sqs_queue" "upload_events_dlq" {
  name                      = "${local.name}-upload-events-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "upload_events" {
  name                       = "${local.name}-upload-events"
  visibility_timeout_seconds = 180 # 6x the Lambda timeout, as AWS recommends
  message_retention_seconds  = 86400
  receive_wait_time_seconds  = 20 # long polling
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.upload_events_dlq.arn
    maxReceiveCount     = 3
  })
}

data "aws_iam_policy_document" "upload_events_queue" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.upload_events.arn]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.files.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "upload_events" {
  queue_url = aws_sqs_queue.upload_events.id
  policy    = data.aws_iam_policy_document.upload_events_queue.json
}

resource "aws_s3_bucket_notification" "files" {
  bucket = aws_s3_bucket.files.id
  queue {
    queue_arn     = aws_sqs_queue.upload_events.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "uploads/"
  }
  depends_on = [aws_sqs_queue_policy.upload_events]
}

# ---------------- SNS: operational alerts ----------------
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------------- DynamoDB: file metadata, TTL expiry, stream ----------------
resource "aws_dynamodb_table" "files" {
  name         = "${local.name}-files"
  billing_mode = "PAY_PER_REQUEST" # on-demand: no idle cost
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
  attribute {
    name = "ownerId"
    type = "S"
  }
  attribute {
    name = "createdAt"
    type = "N"
  }

  global_secondary_index {
    name            = "byOwner"
    hash_key        = "ownerId"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  stream_enabled   = true
  stream_view_type = "OLD_IMAGE" # the expiry Lambda only needs what was deleted

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
}
