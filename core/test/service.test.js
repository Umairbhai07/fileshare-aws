import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileService, createMemoryRepo, hashPassword, verifyPassword, idFromKey, keyFor, newId } from '../src/index.js';

function setup(start = 1_700_000_000_000) {
  let now = start;
  const deleted = [];
  const sizes = new Map();
  const repo = createMemoryRepo();
  const storage = {
    async presignPut(key) { return `https://put/${key}`; },
    async presignGet(key) { return `https://get/${key}`; },
    async head(key) { return sizes.has(key) ? { size: sizes.get(key) } : null; },
    async delete(key) { deleted.push(key); },
  };
  const svc = createFileService({ repo, storage, clock: () => now });
  return { svc, repo, deleted, sizes, advance: (ms) => { now += ms; }, now: () => now };
}
const alice = { sub: 'alice' };
const bob = { sub: 'bob' };

test('ids and keys', () => {
  const id = newId();
  assert.equal(id.length, 12);
  const key = keyFor('alice', id, 'my report (final).pdf');
  assert.equal(key, `uploads/alice/${id}/my_report_final_.pdf`);
  assert.equal(idFromKey(key), id);
  assert.equal(idFromKey('other/x'), null);
});

test('password hashing', async () => {
  const h = await hashPassword('s3cret');
  assert.ok(await verifyPassword('s3cret', h));
  assert.ok(!(await verifyPassword('nope', h)));
  assert.ok(await verifyPassword(undefined, null));
});

test('upload lifecycle: create, S3 event, share, download, expire', async () => {
  const { svc, deleted, advance } = setup();
  const { file, uploadUrl } = await svc.createUpload(alice, { name: 'a.txt', size: 10, contentType: 'text/plain', expiresInHours: 1 });
  assert.equal(file.status, 'pending');
  assert.match(uploadUrl, /^https:\/\/put\/uploads\/alice\//);
  await assert.rejects(svc.getPublic(file.id), { status: 404 });

  const key = `uploads/alice/${file.id}/a.txt`;
  assert.deepEqual((await svc.onObjectCreated(key, 10)).status, 'ready');
  const pub = await svc.getPublic(file.id);
  assert.equal(pub.passwordProtected, false);
  assert.equal(pub.ownerId, undefined, 'public view must not leak owner');

  const dl = await svc.download(file.id);
  assert.equal(dl.downloads, 1);
  const stats = await svc.stats(alice);
  assert.equal(stats.activeFiles, 1);
  assert.equal(stats.lifetime.uploads, 1);
  assert.equal(stats.lifetime.downloads, 1);

  advance(3600_000);
  await assert.rejects(svc.getPublic(file.id), { status: 410 });
  await assert.rejects(svc.download(file.id), { status: 410 });
  assert.equal((await svc.listFiles(alice)).length, 0);
  assert.equal(await svc.sweep(), 1);
  assert.deepEqual(deleted, [key]);
});

test('password and download limit', async () => {
  const { svc } = setup();
  const { file } = await svc.createUpload(alice, { name: 'b.bin', size: 5, expiresInHours: 24, password: 'hunter2', maxDownloads: 1 });
  await svc.onObjectCreated(`uploads/alice/${file.id}/b.bin`, 5);
  assert.equal((await svc.getPublic(file.id)).passwordProtected, true);
  await assert.rejects(svc.download(file.id, 'wrong'), { status: 401 });
  await svc.download(file.id, 'hunter2');
  await assert.rejects(svc.download(file.id, 'hunter2'), { status: 410 });
});

test('validation and ownership', async () => {
  const { svc } = setup();
  await assert.rejects(svc.createUpload(alice, { name: 'x', size: 0 }), { status: 400 });
  await assert.rejects(svc.createUpload(alice, { name: 'x', size: 1, expiresInHours: 48 }), { status: 400 });
  await assert.rejects(svc.createUpload(alice, { name: 'x', size: 3 * 1024 ** 3 }), { status: 413 });
  const { file } = await svc.createUpload(alice, { name: 'x', size: 1 });
  await assert.rejects(svc.deleteFile(bob, file.id), { status: 403 });
  await svc.deleteFile(alice, file.id);
  assert.equal((await svc.listFiles(alice)).length, 0);
});

test('orphan uploads are removed and stale pending uploads are swept', async () => {
  const { svc, deleted, advance } = setup();
  assert.equal((await svc.onObjectCreated('uploads/alice/nope/x', 1)).status, 'orphan');
  assert.deepEqual(deleted, ['uploads/alice/nope/x']);
  await svc.createUpload(alice, { name: 'never-finished', size: 1 });
  advance(2 * 3600_000);
  assert.equal(await svc.sweep(), 1);
});

test('completeUpload uses storage head', async () => {
  const { svc, sizes } = setup();
  const { file } = await svc.createUpload(alice, { name: 'c', size: 7 });
  await assert.rejects(svc.completeUpload(alice, file.id), { status: 400 });
  sizes.set(`uploads/alice/${file.id}/c`, 7);
  assert.equal((await svc.completeUpload(alice, file.id)).status, 'ready');
});

test('rename, extend, preview and bulk delete', async () => {
  const { svc, advance } = setup();
  const a = (await svc.createUpload(alice, { name: 'a.txt', size: 1, expiresInHours: 1 })).file;
  const b = (await svc.createUpload(alice, { name: 'b.txt', size: 1 })).file;
  await svc.onObjectCreated(`uploads/alice/${a.id}/a.txt`, 1);
  advance(30 * 60_000);
  const renamed = await svc.updateFile(alice, a.id, { name: 'final.txt', expiresInHours: 24 });
  assert.equal(renamed.name, 'final.txt');
  assert.equal(renamed.expiresAt - renamed.createdAt, 24 * 3600_000, 'extend is capped at 24h after upload');
  assert.equal((await svc.updateFile(alice, a.id, { message: '  hi there ' })).message, 'hi there');
  await assert.rejects(svc.updateFile(bob, a.id, { name: 'x' }), { status: 403 });
  await assert.rejects(svc.updateFile(alice, a.id, { expiresInHours: 48 }), { status: 400 });
  const pw = await svc.updateFile(alice, a.id, { password: 'abcd', maxDownloads: 3 });
  assert.equal(pw.passwordProtected, true);
  assert.equal(pw.maxDownloads, 3);
  assert.match((await svc.previewUrl(alice, a.id)).url, /^https:\/\/get\//);
  await assert.rejects(svc.previewUrl(alice, b.id), { status: 400 });
  assert.deepEqual(await svc.bulkDelete(alice, [a.id, b.id, 'missing']), { deleted: 2 });
  assert.equal((await svc.listFiles(alice)).length, 0);
});
