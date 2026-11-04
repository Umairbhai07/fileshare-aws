import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileService, createMemoryRepo } from '@fileshare/core';
import { createApp } from '../src/app.js';
import { devAuth } from '../src/auth.js';

function start() {
  const storage = {
    async presignPut(k) { return `https://s3/${k}`; },
    async presignGet(k) { return `https://s3/${k}?get`; },
    async head() { return { size: 3 }; },
    async delete() {},
  };
  const service = createFileService({ repo: createMemoryRepo(), storage });
  const app = createApp({ service, auth: devAuth(), config: { mode: 'aws', instanceId: 'i-test', availabilityZone: 'az-1', version: 't' } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

test('health, upload, list, share, download, delete', async (t) => {
  const { server, base } = start();
  t.after(() => server.close());
  const j = (r) => r.json();

  assert.equal((await j(await fetch(`${base}/health`))).ok, true);
  const created = await fetch(`${base}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hello.txt', size: 3, contentType: 'text/plain', expiresInHours: 24 }),
  });
  assert.equal(created.status, 201);
  const { file, uploadUrl } = await created.json();
  assert.match(uploadUrl, /^https:\/\/s3\/uploads\/local-dev-user\//);

  const done = await j(await fetch(`${base}/api/files/${file.id}/complete`, { method: 'POST' }));
  assert.equal(done.file.status, 'ready');
  assert.equal((await j(await fetch(`${base}/api/files`))).files.length, 1);
  assert.equal((await j(await fetch(`${base}/public/files/${file.id}`))).file.name, 'hello.txt');
  const dl = await j(await fetch(`${base}/public/files/${file.id}/download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.match(dl.url, /\?get$/);
  assert.equal((await j(await fetch(`${base}/api/stats`))).activeDownloads, 1);
  assert.equal((await fetch(`${base}/api/files/${file.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/public/files/${file.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
});
