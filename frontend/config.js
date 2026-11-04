// Local development config. In AWS, Terraform overwrites this file in the frontend bucket
// with the real Cognito settings (see infra/cdn.tf).
window.APP_CONFIG = {
  authMode: 'dev',
  region: '',
  userPoolId: '',
  clientId: '',
};
