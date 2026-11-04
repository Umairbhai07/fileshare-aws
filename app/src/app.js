import express from 'express';
import { HttpError } from '@fileshare/core';

const log = (event, data = {}) => console.log(JSON.stringify({ level: 'info', event, ...data, t: new Date().toISOString() }));

export function createApp({ service, auth, config, localStorage }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '32kb' }));

  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Served-By': `${config.instanceId} (${config.availabilityZone})`,
    });
    if (req.path.startsWith('/api') || req.path.startsWith('/public')) res.set('Cache-Control', 'no-store');
    res.on('finish', () => {
      if (req.path === '/health') return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log('http', { method: req.method, path: typeof req.route?.path === 'string' ? req.baseUrl + req.route.path : req.path, status: res.statusCode, ms: Math.round(ms) });
    });
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // ALB target group health check
  app.get('/health', (_req, res) => res.json({ ok: true, version: config.version, instance: config.instanceId, az: config.availabilityZone }));

  // ---- Authenticated dashboard API (served by EC2 behind the ALB) ----
  const api = express.Router();
  api.use(auth);
  api.get('/me', (req, res) => res.json({ user: req.user, servedBy: { instance: config.instanceId, az: config.availabilityZone, version: config.version } }));
  api.get('/files', wrap(async (req, res) => res.json({ files: await service.listFiles(req.user) })));
  api.post('/files', wrap(async (req, res) => res.status(201).json(await service.createUpload(req.user, req.body))));
  api.post('/files/:id/complete', wrap(async (req, res) => res.json({ file: await service.completeUpload(req.user, req.params.id) })));
  api.post('/files/bulk-delete', wrap(async (req, res) => res.json(await service.bulkDelete(req.user, req.body?.ids))));
  api.patch('/files/:id', wrap(async (req, res) => res.json({ file: await service.updateFile(req.user, req.params.id, req.body || {}) })));
  api.get('/files/:id/preview', wrap(async (req, res) => res.json(await service.previewUrl(req.user, req.params.id))));
  api.delete('/files/:id', wrap(async (req, res) => {
    await service.deleteFile(req.user, req.params.id);
    res.status(204).end();
  }));
  api.get('/stats', wrap(async (req, res) => res.json(await service.stats(req.user))));
  app.use('/api', api);

  // ---- Public share API. In AWS, CloudFront routes /public/* to API Gateway + Lambda;
  // the app serves the same routes for local development. ----
  app.get('/public/files/:id', wrap(async (req, res) => res.json({ file: await service.getPublic(req.params.id) })));
  app.post('/public/files/:id/download', wrap(async (req, res) => res.json(await service.download(req.params.id, req.body?.password))));

  if (config.mode === 'local') mountLocalDev(app, { service, config, localStorage });

  app.use((req, res) => res.status(404).json({ error: 'not_found', message: 'Route not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request', message: 'Invalid JSON' });
    console.error(JSON.stringify({ level: 'error', event: 'unhandled', message: err.message, stack: err.stack }));
    res.status(500).json({ error: 'internal', message: 'Something went wrong' });
  });
  return app;
}

// Emulates S3 presigned URLs, the S3 event Lambda and CloudFront's /d/<id> rewrite on one port.
function mountLocalDev(app, { service, config, localStorage }) {
  app.put(/^\/dev-storage\/(.+)$/, async (req, res, next) => {
    try {
      const key = decodeURIComponent(req.params[0]);
      if (!localStorage.verify('put', key, req.query.exp, req.query.sig)) return res.status(403).send('Bad signature');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      await localStorage.write(key, buf);
      await service.onObjectCreated(key, buf.length); // what S3 -> SQS -> Lambda does in AWS
      res.set('ETag', '"local"').status(200).end();
    } catch (e) { next(e); }
  });
  app.get(/^\/dev-storage\/(.+)$/, (req, res) => {
    const key = decodeURIComponent(req.params[0]);
    if (!localStorage.verify('get', key, req.query.exp, req.query.sig)) return res.status(403).send('Bad signature');
    if (req.query.inline) return res.sendFile(localStorage.fileFor(key), { dotfiles: 'allow' });
    res.download(localStorage.fileFor(key), String(req.query.name || 'file'), { dotfiles: 'allow' });
  });
  app.options(/^\/dev-storage\/.*/, (_req, res) => res.status(204).end());
  // Same rewrites the CloudFront Function does in AWS
  app.get('/d/:id', (_req, res) => res.sendFile('share.html', { root: config.local.frontendDir }));
  for (const page of ['app', 'login', 'signup', 'forgot']) {
    app.get(`/${page}`, (_req, res) => res.sendFile(`${page}.html`, { root: config.local.frontendDir }));
  }
  app.use(express.static(config.local.frontendDir, { extensions: ['html'] }));
}
