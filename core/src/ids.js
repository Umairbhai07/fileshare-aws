import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 12 chars from a 57-char alphabet is ~70 bits: unguessable share ids.
export function newId(length = 12) {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    const b = bytes[i];
    if (b < ALPHABET.length * 4) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

export function safeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned || 'file';
}

// Object keys look like uploads/<ownerId>/<fileId>/<name>
export function keyFor(ownerId, id, name) {
  const keyName = safeFileName(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return `uploads/${ownerId}/${id}/${keyName}`;
}

export function idFromKey(key) {
  const parts = String(key).split('/');
  return parts[0] === 'uploads' && parts.length >= 4 ? parts[2] : null;
}
