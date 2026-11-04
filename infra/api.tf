# API Gateway HTTP API -> Lambda for public share links. Serverless scales to zero and absorbs
# download spikes without touching the EC2 fleet; throttling protects against abuse.
resource "aws_apigatewayv2_api" "public" {
  name          = "${local.name}-public"
  protocol_type = "HTTP"
  description   = "Public share-link API"
}

resource "aws_apigatewayv2_integration" "share" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn["share-api"].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "share" {
  for_each  = toset(["GET /public/files/{id}", "POST /public/files/{id}/download"])
  api_id    = aws_apigatewayv2_api.public.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.share.id}"
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/${local.name}/apigw-access"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.public.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId = "$context.requestId", ip = "$context.identity.sourceIp", route = "$context.routeKey",
      status    = "$context.status", latency = "$context.integrationLatency", time = "$context.requestTime"
    })
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["share-api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*"
}
