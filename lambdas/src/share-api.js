// API Gateway (HTTP API) -> Lambda: the public, unauthenticated side of a share link.
import { HttpError } from '@fileshare/core';
import { getService, metric } from './shared.js';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

export async function handler(event) {
  const service = getService();
  const id = event.pathParameters?.id;
  try {
    switch (event.routeKey) {
      case 'GET /public/files/{id}':
        return json(200, { file: await service.getPublic(id) });
      case 'POST /public/files/{id}/download': {
        let body = {};
        try {
          const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body;
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return json(400, { error: 'bad_request', message: 'Invalid JSON' });
        }
        const result = await service.download(id, body.password);
        metric('Downloads', 1);
        return json(200, result);
      }
      default:
        return json(404, { error: 'not_found', message: 'Route not found' });
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.code === 'wrong_password') metric('WrongPasswordAttempts', 1);
      return json(err.status, { error: err.code, message: err.message });
    }
    console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack }));
    return json(500, { error: 'internal', message: 'Something went wrong' });
  }
}
