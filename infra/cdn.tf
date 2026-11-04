# One CloudFront distribution gives one HTTPS origin for everything (no CORS, no custom domain needed):
#   /*         -> S3 frontend bucket (Origin Access Control, cached at the edge)
#   /api/*     -> ALB -> EC2 Auto Scaling group (dashboard API)
#   /public/*  -> API Gateway -> Lambda (public share links)
resource "aws_s3_bucket" "frontend" {
  bucket        = "${local.name}-web-${local.account_id}-${local.suffix}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.name}-frontend"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket     = aws_s3_bucket.frontend.id
  policy     = data.aws_iam_policy_document.frontend_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

# The API must never be cached, but the Authorization header has to reach the origin. A cache
# policy with TTL 0 that keys on Authorization does both.
resource "aws_cloudfront_cache_policy" "api" {
  name        = "${local.name}-api-no-cache"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 1
  parameters_in_cache_key_and_forwarded_to_origin {
    headers_config {
      header_behavior = "whitelist"
      headers { items = ["Authorization"] }
    }
    cookies_config { cookie_behavior = "none" }
    query_strings_config { query_string_behavior = "all" }
  }
}

# Edge function: pretty share links. /d/<id> serves share.html.
resource "aws_cloudfront_function" "rewrite" {
  name    = "${local.name}-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var req = event.request;
      if (/^\/d\/[A-Za-z0-9]+\/?$/.test(req.uri)) req.uri = '/share.html';
      return req;
    }
  JS
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  comment             = "${local.name} web + API"
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # North America + Europe edges only: cheapest
  http_version        = "http2and3"
  is_ipv6_enabled     = true

  origin {
    origin_id                = "frontend"
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_secret.result
    }
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # no custom domain = no ACM cert for the ALB; the ALB only accepts CloudFront
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    origin_id   = "apigw"
    domain_name = replace(aws_apigatewayv2_api.public.api_endpoint, "https://", "")
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = aws_cloudfront_cache_policy.api.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  ordered_cache_behavior {
    path_pattern             = "/public/*"
    target_origin_id         = "apigw"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# ---- Frontend files (uploaded by Terraform so one `apply` ships everything) ----
locals {
  frontend_dir = "${path.module}/../frontend"
  mime = {
    html = "text/html; charset=utf-8", css = "text/css; charset=utf-8", js = "application/javascript; charset=utf-8",
    svg  = "image/svg+xml", png = "image/png", ico = "image/x-icon", json = "application/json"
  }
  frontend_files = [for f in fileset(local.frontend_dir, "**") : f if f != "config.js"]
}

resource "aws_s3_object" "frontend" {
  for_each      = toset(local.frontend_files)
  bucket        = aws_s3_bucket.frontend.id
  key           = each.value
  source        = "${local.frontend_dir}/${each.value}"
  etag          = filemd5("${local.frontend_dir}/${each.value}")
  content_type  = lookup(local.mime, regex("[^.]+$", each.value), "application/octet-stream")
  cache_control = endswith(each.value, ".html") ? "no-cache" : "public, max-age=300"
}

resource "aws_s3_object" "config" {
  bucket        = aws_s3_bucket.frontend.id
  key           = "config.js"
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
  content = <<-JS
    window.APP_CONFIG = ${jsonencode({
  authMode      = "cognito"
  cognitoDomain = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
  clientId      = aws_cognito_user_pool_client.web.id
})};
  JS
}
