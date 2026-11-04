import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { unauthorized } from '@fileshare/core';

/** Express middleware: verifies the Cognito access token (JWKS cached in memory). */
export function cognitoAuth({ userPoolId, clientId, jwks }) {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'access' });
  if (jwks) {
    // Instances in private subnets have no internet route to download the signing keys,
    // so Terraform passes them in at boot.
    verifier.cacheJwks(typeof jwks === 'string' ? JSON.parse(jwks) : jwks);
  } else {
    verifier.hydrate().catch(() => {}); // warm the JWKS cache at boot
  }
  return async (req, _res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return next(unauthorized());
    try {
      const claims = await verifier.verify(token);
      req.user = { sub: claims.sub, username: claims.username };
      next();
    } catch {
      next(unauthorized('Session expired, please sign in again'));
    }
  };
}

/** Local development: everyone is the same demo user. */
export function devAuth() {
  return (req, _res, next) => {
    req.user = { sub: 'local-dev-user', username: 'dev@localhost' };
    next();
  };
}
