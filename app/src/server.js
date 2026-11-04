import { createFileService, createMemoryRepo, createLocalStorage } from '@fileshare/core';
import { createApp } from './app.js';
import { cognitoAuth, devAuth } from './auth.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const log = (event, data) => console.log(JSON.stringify({ level: 'info', event, ...data, t: new Date().toISOString() }));

let service, auth, localStorage;
if (config.mode === 'local') {
  localStorage = createLocalStorage({ dir: `${config.local.dataDir}/files`, baseUrl: config.local.publicUrl });
  service = createFileService({ repo: createMemoryRepo(), storage: localStorage, log });
  auth = devAuth();
  // Local stand-in for the EventBridge-scheduled sweeper Lambda
  setInterval(() => service.sweep().catch(console.error), 60_000).unref();
} else {
  const { createDynamoRepo, createS3Storage } = await import('@fileshare/core/aws');
  for (const k of ['tableName', 'bucket']) if (!config[k]) throw new Error(`Missing config: ${k}`);
  service = createFileService({
    repo: createDynamoRepo({ tableName: config.tableName }),
    storage: createS3Storage({ bucket: config.bucket }),
    log,
  });
  auth = cognitoAuth(config.cognito);
}

const app = createApp({ service, auth, config, localStorage });
const server = app.listen(config.port, () => log('server.started', { port: config.port, mode: config.mode, version: config.version }));

// Graceful shutdown so ASG instance refreshes / ALB deregistration don't cut requests.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('server.stopping', { sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
