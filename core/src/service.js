import { badRequest, forbidden, gone, notFound, tooLarge, HttpError } from './errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { newId, keyFor, idFromKey, safeFileName } from './ids.js';

const HOUR = 3600_000;
export const EXPIRY_CHOICES_HOURS = [1, 6, 12, 24];
export const PENDING_UPLOAD_TIMEOUT_MS = HOUR;
export const MAX_LIFETIME_MS = 24 * HOUR;

export const DEFAULT_LIMITS = {
  maxFileBytes: 2 * 1024 ** 3, // 2 GB per file (single presigned PUT supports up to 5 GB)
  maxActiveBytesPerUser: 10 * 1024 ** 3, // 10 GB of live files per user
  maxActiveFilesPerUser: 200,
};

export function fileStatus(item, now) {
  if (item.expiresAt <= now) return 'expired';
  if (item.maxDownloads > 0 && item.downloads >= item.maxDownloads) return 'limit_reached';
  return item.status; // pending | ready
}

export function privateView(item, now) {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    contentType: item.contentType,
    status: fileStatus(item, now),
    createdAt: item.createdAt,
    uploadedAt: item.uploadedAt ?? null,
    expiresAt: item.expiresAt,
    downloads: item.downloads ?? 0,
    maxDownloads: item.maxDownloads ?? 0,
    lastDownloadAt: item.lastDownloadAt ?? null,
    passwordProtected: Boolean(item.passwordHash),
    message: item.message || '',
  };
}

export function publicView(item, now) {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    contentType: item.contentType,
    expiresAt: item.expiresAt,
    createdAt: item.createdAt,
    downloads: item.downloads ?? 0,
    maxDownloads: item.maxDownloads ?? 0,
    passwordProtected: Boolean(item.passwordHash),
    message: item.message || '',
    status: fileStatus(item, now),
  };
}

/**
 * The domain logic, shared by the EC2 API (dashboard) and the Lambdas (public share API,
 * S3 event processing, expiry cleanup). Persistence and storage are injected so the same
 * code runs against DynamoDB + S3 in AWS and against memory + disk locally.
 */
export function createFileService({ repo, storage, limits = DEFAULT_LIMITS, clock = () => Date.now(), log = () => {} }) {
  async function createUpload(user, input = {}) {
    const name = safeFileName(input.name);
    const size = Number(input.size);
    const contentType = String(input.contentType || 'application/octet-stream').slice(0, 200);
    const expiresInHours = Number(input.expiresInHours ?? 24);
    const maxDownloads = input.maxDownloads == null || input.maxDownloads === '' ? 0 : Number(input.maxDownloads);
    const password = input.password ? String(input.password) : '';
    const message = input.message ? String(input.message).trim().slice(0, 500) : '';

    if (!Number.isInteger(size) || size <= 0) throw badRequest('size must be a positive integer');
    if (size > limits.maxFileBytes) throw tooLarge(`Files can be at most ${Math.round(limits.maxFileBytes / 1024 ** 3)} GB`);
    if (!EXPIRY_CHOICES_HOURS.includes(expiresInHours)) throw badRequest(`expiresInHours must be one of ${EXPIRY_CHOICES_HOURS.join(', ')}`);
    if (!Number.isInteger(maxDownloads) || maxDownloads < 0 || maxDownloads > 1000) throw badRequest('maxDownloads must be between 0 (unlimited) and 1000');
    if (password && (password.length < 4 || password.length > 128)) throw badRequest('Password must be 4 to 128 characters');

    const now = clock();
    const active = (await repo.listByOwner(user.sub)).filter((f) => f.expiresAt > now);
    const activeBytes = active.reduce((sum, f) => sum + (f.size || 0), 0);
    if (active.length >= limits.maxActiveFilesPerUser) throw new HttpError(429, 'quota', 'Too many active files. Delete some or wait for them to expire.');
    if (activeBytes + size > limits.maxActiveBytesPerUser) throw new HttpError(429, 'quota', 'Storage quota reached. Delete some files or wait for them to expire.');

    const id = newId();
    const expiresAt = now + expiresInHours * HOUR;
    const item = {
      id,
      ownerId: user.sub,
      name,
      size,
      contentType,
      key: keyFor(user.sub, id, name),
      status: 'pending',
      createdAt: now,
      expiresAt,
      ttl: Math.ceil(expiresAt / 1000), // DynamoDB TTL attribute (epoch seconds)
      downloads: 0,
      maxDownloads,
      passwordHash: password ? await hashPassword(password) : null,
      message: message || null,
    };
    await repo.put(item);
    const uploadUrl = await storage.presignPut(item.key, size, contentType);
    log('file.created', { id, size, expiresInHours, protected: Boolean(password) });
    return { file: privateView(item, now), uploadUrl, shareId: id };
  }

  async function listFiles(user) {
    const now = clock();
    const items = await repo.listByOwner(user.sub);
    return items
      .filter((f) => f.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((f) => privateView(f, now));
  }

  async function deleteFile(user, id) {
    const item = await repo.get(id);
    if (!item || !item.ownerId) throw notFound();
    if (item.ownerId !== user.sub) throw forbidden();
    await storage.delete(item.key);
    await repo.delete(id);
    log('file.deleted', { id });
  }

  // Mark an upload finished (called by the app when the browser reports success, and by the
  // S3-event Lambda, which is the source of truth).
  async function completeUpload(user, id) {
    const item = await repo.get(id);
    if (!item || item.ownerId !== user.sub) throw notFound();
    if (item.status === 'ready') return privateView(item, clock());
    const head = await storage.head(item.key);
    if (!head) throw badRequest('Upload not found in storage yet');
    const updated = await repo.markReady(id, head.size, clock());
    if (updated) await repo.bumpUserStats(item.ownerId, { uploads: 1, bytes: head.size });
    return privateView(updated || item, clock());
  }

  async function ownedItem(user, id) {
    const item = await repo.get(String(id || ''));
    if (!item || !item.ownerId) throw notFound();
    if (item.ownerId !== user.sub) throw forbidden();
    if (item.expiresAt <= clock()) throw gone();
    return item;
  }

  // Rename (display name only; the S3 key never changes) and/or extend expiry to N hours from now.
  async function updateFile(user, id, input = {}) {
    const item = await ownedItem(user, id);
    const fields = {};
    if (input.name !== undefined) {
      const name = safeFileName(input.name);
      if (!name.trim()) throw badRequest('Name cannot be empty');
      fields.name = name;
    }
    if (input.expiresInHours !== undefined) {
      const h = Number(input.expiresInHours);
      if (!EXPIRY_CHOICES_HOURS.includes(h)) throw badRequest(`expiresInHours must be one of ${EXPIRY_CHOICES_HOURS.join(', ')}`);
      // Never past 24 hours after upload: the S3 lifecycle rule deletes objects after 1 day.
      fields.expiresAt = Math.min(clock() + h * HOUR, item.createdAt + MAX_LIFETIME_MS);
      fields.ttl = Math.ceil(fields.expiresAt / 1000);
    }
    if (input.message !== undefined) {
      fields.message = String(input.message || '').trim().slice(0, 500) || null;
    }
    if (input.maxDownloads !== undefined) {
      const m = Number(input.maxDownloads || 0);
      if (!Number.isInteger(m) || m < 0 || m > 1000) throw badRequest('maxDownloads must be between 0 (unlimited) and 1000');
      fields.maxDownloads = m;
    }
    if (input.password !== undefined) {
      const pw = String(input.password || '');
      if (pw && (pw.length < 4 || pw.length > 128)) throw badRequest('Password must be 4 to 128 characters');
      fields.passwordHash = pw ? await hashPassword(pw) : null;
    }
    if (!Object.keys(fields).length) throw badRequest('Nothing to update');
    const updated = await repo.update(id, fields);
    if (!updated) throw notFound();
    log('file.updated', { id, fields: Object.keys(fields) });
    return privateView(updated, clock());
  }

  // Owner preview: a short-lived inline URL that does not count as a download.
  async function previewUrl(user, id) {
    const item = await ownedItem(user, id);
    if (item.status !== 'ready') throw badRequest('Upload not finished yet');
    return { url: await storage.presignGet(item.key, item.name, item.contentType, { inline: true }) };
  }

  async function bulkDelete(user, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw badRequest('ids must be a list of 1 to 100 file ids');
    let deleted = 0;
    for (const id of ids) {
      try {
        await deleteFile(user, String(id));
        deleted += 1;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    return { deleted };
  }

  async function stats(user) {
    const now = clock();
    const items = (await repo.listByOwner(user.sub)).filter((f) => f.expiresAt > now);
    const lifetime = (await repo.getUserStats(user.sub)) || {};
    const hourly = Array.from({ length: 24 }, (_, i) => ({ hourStart: now - (23 - i) * HOUR - (now % HOUR), uploads: 0, bytes: 0 }));
    const byType = {};
    for (const f of items) {
      const idx = 23 - Math.floor((now - (now % HOUR) - (f.createdAt - (f.createdAt % HOUR))) / HOUR);
      if (idx >= 0 && idx < 24) {
        hourly[idx].uploads += 1;
        hourly[idx].bytes += f.size || 0;
      }
      const type = (f.contentType || 'other').split('/')[0] || 'other';
      byType[type] = (byType[type] || 0) + (f.size || 0);
    }
    return {
      activeFiles: items.length,
      activeBytes: items.reduce((s, f) => s + (f.size || 0), 0),
      activeDownloads: items.reduce((s, f) => s + (f.downloads || 0), 0),
      protectedFiles: items.filter((f) => f.passwordHash).length,
      expiringSoon: items.filter((f) => f.expiresAt - now < 3 * HOUR).length,
      quotaBytes: limits.maxActiveBytesPerUser,
      lifetime: {
        uploads: lifetime.uploads || 0,
        bytes: lifetime.bytes || 0,
        downloads: lifetime.downloads || 0,
      },
      hourly,
      byType,
    };
  }

  async function getPublic(id) {
    const now = clock();
    const item = await repo.get(String(id || ''));
    if (!item || !item.ownerId) throw notFound();
    if (item.expiresAt <= now) throw gone();
    if (item.status !== 'ready') throw notFound('This file is still uploading');
    return publicView(item, now);
  }

  async function download(id, password) {
    const now = clock();
    const item = await repo.get(String(id || ''));
    if (!item || !item.ownerId) throw notFound();
    if (item.expiresAt <= now) throw gone();
    if (item.status !== 'ready') throw notFound('This file is still uploading');
    if (!(await verifyPassword(password, item.passwordHash))) throw new HttpError(401, 'wrong_password', 'Wrong password');
    // Atomic, conditional increment: fails if the file expired or hit its download limit meanwhile.
    const updated = await repo.incrementDownloads(id, now);
    if (!updated) throw gone(item.maxDownloads > 0 ? 'This file reached its download limit' : 'This link has expired');
    await repo.bumpUserStats(item.ownerId, { downloads: 1 });
    const url = await storage.presignGet(item.key, item.name, item.contentType);
    log('file.downloaded', { id, downloads: updated.downloads });
    return { url, downloads: updated.downloads };
  }

  // S3 ObjectCreated -> SQS -> Lambda
  async function onObjectCreated(key, size) {
    const id = idFromKey(key);
    const item = id ? await repo.get(id) : null;
    if (!item || item.key !== key || item.expiresAt <= clock()) {
      // Orphan upload (deleted or expired before the upload finished): remove it.
      await storage.delete(key);
      log('upload.orphan_removed', { key });
      return { status: 'orphan' };
    }
    if (item.status === 'ready') return { status: 'already_ready' };
    const updated = await repo.markReady(id, size, clock());
    if (updated) await repo.bumpUserStats(item.ownerId, { uploads: 1, bytes: size });
    log('upload.ready', { id, size });
    return { status: 'ready', id, size };
  }

  // DynamoDB TTL REMOVE -> stream -> Lambda
  async function onItemRemoved(oldItem) {
    if (!oldItem?.key) return false;
    await storage.delete(oldItem.key);
    log('file.expired_object_removed', { id: oldItem.id });
    return true;
  }

  // EventBridge schedule -> Lambda. DynamoDB TTL can lag, so this enforces expiry promptly.
  async function sweep() {
    const now = clock();
    const stale = await repo.scanExpired(now, now - PENDING_UPLOAD_TIMEOUT_MS);
    for (const item of stale) {
      await storage.delete(item.key);
      await repo.delete(item.id);
    }
    log('sweep.done', { removed: stale.length });
    return stale.length;
  }

  return { createUpload, completeUpload, listFiles, deleteFile, updateFile, previewUrl, bulkDelete, stats, getPublic, download, onObjectCreated, onItemRemoved, sweep };
}
