// Local development config. In AWS, Terraform overwrites this file in the frontend bucket
// with the real Cognito settings (see infra/frontend.tf).
window.APP_CONFIG = {
  authMode: 'dev',
  cognitoDomain: '',
  clientId: '',
};
