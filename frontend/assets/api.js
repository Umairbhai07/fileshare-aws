import { auth } from './auth.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = await auth.accessToken();
  if (token && token !== 'dev') headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path.startsWith('/api')) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Browser -> S3 with a presigned PUT and progress events. The API never touches file bytes. */
export function putWithProgress(url, file, contentType, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(file);
  });
  promise.abort = () => xhr.abort();
  return promise;
}
