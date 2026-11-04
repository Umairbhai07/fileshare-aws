import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { cognitoAuth } from '../src/auth.js';

// Signs a Cognito-shaped access token with a local RSA key and checks the middleware
// verifies it offline using only the JWKS passed in (as private EC2 instances do).
test('verifies Cognito access tokens with a preloaded JWKS (no network)', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const pool = 'us-east-1_TEST123';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const sign = (claims) => {
    const data = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`;
    return `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')}`;
  };
  const good = sign({ sub: 'user-1', username: 'u', client_id: 'client', token_use: 'access', iss: `https://cognito-idp.us-east-1.amazonaws.com/${pool}`, exp: now + 600, iat: now, jti: randomUUID() });
  const mw = cognitoAuth({ userPoolId: pool, clientId: 'client', jwks: JSON.stringify({ keys: [jwk] }) });
  const run = (token) => new Promise((resolve) => {
    const req = { get: () => (token ? `Bearer ${token}` : '') };
    mw(req, {}, (err) => resolve({ err, user: req.user }));
  });
  assert.deepEqual((await run(good)).user, { sub: 'user-1', username: 'u' });
  assert.equal((await run(good.slice(0, -4) + 'AAAA')).err.status, 401);
  assert.equal((await run('')).err.status, 401);
});
