import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadConfig(env = process.env) {
  const mode = env.MODE === 'local' ? 'local' : 'aws';
  const port = Number(env.PORT || 8080);
  return {
    mode,
    port,
    version: env.APP_VERSION || 'dev',
    instanceId: env.INSTANCE_ID || 'local',
    availabilityZone: env.AVAILABILITY_ZONE || 'local',
    tableName: env.TABLE_NAME,
    bucket: env.FILES_BUCKET,
    cognito: { userPoolId: env.COGNITO_USER_POOL_ID, clientId: env.COGNITO_CLIENT_ID, jwks: env.COGNITO_JWKS },
    local: {
      dataDir: env.DATA_DIR || path.join(root, '.data'),
      publicUrl: env.PUBLIC_URL || `http://localhost:${port}`,
      frontendDir: env.FRONTEND_DIR || path.join(root, 'frontend'),
    },
  };
}
