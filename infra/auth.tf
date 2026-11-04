# Cognito User Pool + Hosted UI. The SPA signs in with Authorization Code + PKCE (no client secret).
resource "aws_cognito_user_pool" "main" {
  name                     = "${local.name}-users"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = "INACTIVE"

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config { allow_admin_create_user_only = false }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Sharebox verification code"
    email_message        = "Your Sharebox verification code is {####}"
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${local.name}-${local.suffix}"
  user_pool_id = aws_cognito_user_pool.main.id
}

locals {
  app_origin = "https://${aws_cloudfront_distribution.main.domain_name}"
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${local.name}-web"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.app_origin}/", "http://localhost:8080/"]
  logout_urls                          = ["${local.app_origin}/", "http://localhost:8080/"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

# Private instances have no internet route, so they can't download the JWKS (token signing keys)
# at runtime. Terraform fetches it once and hands it to the app; the keys don't rotate.
data "http" "jwks" {
  url = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}/.well-known/jwks.json"
}
