// In-memory repository + local-disk storage for local development and tests.
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';

export function createMemoryRepo() {
  const items = new Map();
  const userStats = new Map();
  const clone = (x) => (x ? structuredClone(x) : null);
  return {
    _items: items,
    async put(item) { items.set(item.id, clone(item)); },
    async get(id) { return clone(items.get(id)); },
    async delete(id) { items.delete(id); },
    async listByOwner(ownerId) { return [...items.values()].filter((i) => i.ownerId === ownerId).map(clone); },
    async markReady(id, size, now) {
      const it = items.get(id);
      if (!it) return null;
      Object.assign(it, { status: 'ready', size, uploadedAt: now });
      return clone(it);
    },
    async incrementDownloads(id, now) {
      const it = items.get(id);
      if (!it || it.status !== 'ready' || it.expiresAt <= now) return null;
      if (it.maxDownloads > 0 && it.downloads >= it.maxDownloads) return null;
      it.downloads += 1;
      it.lastDownloadAt = now;
      return clone(it);
    },
    async scanExpired(now, pendingBefore) {
      return [...items.values()].filter((i) => i.expiresAt <= now || (i.status === 'pending' && i.createdAt < pendingBefore)).map(clone);
    },
    async bumpUserStats(ownerId, delta) {
      const s = userStats.get(ownerId) || { uploads: 0, bytes: 0, downloads: 0 };
      for (const [k, v] of Object.entries(delta)) s[k] = (s[k] || 0) + v;
      userStats.set(ownerId, s);
    },
    async getUserStats(ownerId) { return clone(userStats.get(ownerId)); },
  };
}

/** Local storage that mimics S3 presigned URLs with an HMAC-signed path served by the dev app. */
export function createLocalStorage({ dir, baseUrl, secret = 'dev-secret' }) {
  const sign = (op, key, exp) => createHmac('sha256', secret).update(`${op}:${key}:${exp}`).digest('hex').slice(0, 32);
  const fileFor = (key) => {
    const p = path.resolve(dir, key);
    if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error('bad key');
    return p;
  };
  const url = (op, key, ttl, extra = '') => {
    const exp = Date.now() + ttl * 1000;
    return `${baseUrl}/dev-storage/${key.split('/').map(encodeURIComponent).join('/')}?op=${op}&exp=${exp}&sig=${sign(op, key, exp)}${extra}`;
  };
  return {
    dir,
    fileFor,
    verify(op, key, exp, sig) { return Number(exp) > Date.now() && sig === sign(op, key, exp); },
    async presignPut(key) { return url('put', key, 900); },
    async presignGet(key, name) { return url('get', key, 300, `&name=${encodeURIComponent(name)}`); },
    async head(key) {
      try { return { size: (await stat(fileFor(key))).size }; } catch { return null; }
    },
    async delete(key) { await rm(fileFor(key), { force: true }); },
    async ensureDir(key) { await mkdir(path.dirname(fileFor(key)), { recursive: true }); },
    async write(key, buf) { await mkdir(path.dirname(fileFor(key)), { recursive: true }); await writeFile(fileFor(key), buf); },
  };
}
