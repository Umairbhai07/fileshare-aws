import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createFileService, createMemoryRepo } from '@fileshare/core';
import { setService } from '../src/shared.js';
import { handler as shareApi } from '../src/share-api.js';
import { handler as processUpload } from '../src/process-upload.js';
import { handler as expiryStream } from '../src/expiry-stream.js';
import { handler as sweeper } from '../src/sweeper.js';

const deleted = [];
const storage = {
  async presignPut(k) { return `put:${k}`; },
  async presignGet(k) { return `get:${k}`; },
  async head() { return null; },
  async delete(k) { deleted.push(k); },
};
const repo = createMemoryRepo();
const service = createFileService({ repo, storage });
setService(service);
const origLog = console.log;

test('S3 event via SQS marks upload ready, then share API serves it', async (t) => {
  console.log = () => {};
  t.after(() => { console.log = origLog; });
  const { file } = await service.createUpload({ sub: 'u1' }, { name: 'my file.txt', size: 4, password: 'pass' });
  const key = `uploads/u1/${file.id}/my_file.txt`;
  const sqs = { Records: [
    { messageId: 'm1', body: JSON.stringify({ Records: [{ s3: { object: { key: key.replace(/ /g, '+'), size: 4 } } }] }) },
    { messageId: 'm2', body: 'not json' },
    { messageId: 'm3', body: JSON.stringify({ Event: 's3:TestEvent' }) },
  ] };
  assert.deepEqual(await processUpload(sqs), { batchItemFailures: [{ itemIdentifier: 'm2' }] });

  const info = await shareApi({ routeKey: 'GET /public/files/{id}', pathParameters: { id: file.id } });
  assert.equal(info.statusCode, 200);
  assert.equal(JSON.parse(info.body).file.passwordProtected, true);

  const wrong = await shareApi({ routeKey: 'POST /public/files/{id}/download', pathParameters: { id: file.id }, body: '{"password":"x"}' });
  assert.equal(wrong.statusCode, 401);
  const ok = await shareApi({ routeKey: 'POST /public/files/{id}/download', pathParameters: { id: file.id }, body: Buffer.from('{"password":"pass"}').toString('base64'), isBase64Encoded: true });
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).url, `get:${key}`);

  const missing = await shareApi({ routeKey: 'GET /public/files/{id}', pathParameters: { id: 'nope' } });
  assert.equal(missing.statusCode, 404);
});

test('stream REMOVE deletes object, sweeper runs', async (t) => {
  console.log = () => {};
  t.after(() => { console.log = origLog; });
  const res = await expiryStream({ Records: [
    { eventName: 'REMOVE', userIdentity: { principalId: 'dynamodb.amazonaws.com' }, dynamodb: { SequenceNumber: '1', OldImage: marshall({ id: 'x', key: 'uploads/u/x/f' }) } },
    { eventName: 'INSERT', dynamodb: { SequenceNumber: '2', NewImage: {} } },
  ] });
  assert.deepEqual(res.batchItemFailures, []);
  assert.ok(deleted.includes('uploads/u/x/f'));
  assert.deepEqual(await sweeper(), { removed: 0 });
});
