import { $, esc, formatBytes, countdown, ext, icon } from './util.js';

const id = location.pathname.startsWith('/d/') ? location.pathname.split('/')[2] : new URLSearchParams(location.search).get('id');
const root = $('#root');
let file;

function message(title, text) {
  root.innerHTML = `<div class="card share-card"><div class="top">
    <div class="file-icon big">${icon('clock').replace('<svg', '<svg width="24" height="24"')}</div>
    <h1>${esc(title)}</h1><div class="muted">${esc(text)}</div></div>
    <div class="bottom"><a class="btn btn-lg" href="/">Share your own files</a></div></div>`;
}

async function load() {
  if (!id) return message('Link not found', 'This share link is incomplete.');
  try {
    const res = await fetch(`/public/files/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (res.status === 410) return message('This link has expired', 'Files are deleted automatically after they expire.');
    if (!res.ok) return message('File not found', data.message || 'It may have been deleted by its owner.');
    file = data.file;
    render();
    setInterval(tickExpiry, 1000);
  } catch {
    message('Something went wrong', 'Please try again in a moment.');
  }
}

function render() {
  const limitLeft = file.maxDownloads ? file.maxDownloads - file.downloads : null;
  document.title = `${file.name} · Sharebox`;
  root.innerHTML = `<div class="card share-card">
    <div class="top">
      <div class="file-icon big">${esc(ext(file.name).slice(0, 4))}</div>
      <h1>${esc(file.name)}</h1>
      <div class="muted">${formatBytes(file.size)} · ${esc(file.contentType)}</div>
    </div>
    <div class="meta">
      <div>Expires in<b id="exp">${countdown(file.expiresAt - Date.now())}</b></div>
      <div>Downloads<b>${file.downloads}</b></div>
      <div>${limitLeft == null ? 'Limit' : 'Left'}<b>${limitLeft == null ? 'None' : limitLeft}</b></div>
    </div>
    <form class="bottom" id="dl-form">
      ${file.passwordProtected ? `<label class="field"><span>${icon('lock').replace('<svg', '<svg width="13" height="13" style="vertical-align:-2px"')} This file is password protected</span>
        <input class="input" id="pw" type="password" placeholder="Enter password" required autocomplete="off" style="height:40px"></label>` : ''}
      <div class="error-text hidden" id="err"></div>
      <button class="btn btn-primary btn-lg" id="dl" type="submit">${icon('download')}Download</button>
      <div class="muted" style="font-size:12px;text-align:center">Shared with Sharebox. The link stops working when the timer ends.</div>
    </form>
  </div>`;
  $('#dl-form').onsubmit = download;
}

function tickExpiry() {
  const left = file.expiresAt - Date.now();
  const el = $('#exp');
  if (el) el.textContent = countdown(left);
  if (left <= 0) location.reload();
}

async function download(e) {
  e.preventDefault();
  const btn = $('#dl');
  const err = $('#err');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="border-top-color:#fff;border-color:rgba(255,255,255,.3)"></span>Preparing…';
  err.classList.add('hidden');
  try {
    const res = await fetch(`/public/files/${encodeURIComponent(id)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('#pw')?.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Download failed');
    location.assign(data.url); // short-lived presigned S3 URL
    file.downloads = data.downloads;
    setTimeout(render, 800);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = `${icon('download')}Download`;
  }
}

load();
