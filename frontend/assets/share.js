import { $, esc, formatBytes, clock, fileIcon, icon, logoHtml } from './util.js';

const DAY = 24 * 3600 * 1000;
const id = location.pathname.startsWith('/d/') ? location.pathname.split('/')[2] : new URLSearchParams(location.search).get('id');
const root = $('#root');
let file;
let timer;

$('#hdr').innerHTML = `${logoHtml()}<a class="btn btn-ghost btn-sm" href="/signup">Share a file</a>`;

function message(title, text, ic = 'clock') {
  clearInterval(timer);
  root.innerHTML = `<div class="share-card fade-up"><div class="top">
    <div class="state-icon">${icon(ic, 26)}</div>
    <h1>${esc(title)}</h1><p class="muted" style="margin-top:6px">${esc(text)}</p></div>
    <form><a class="btn btn-dark" href="/signup">Share your own files</a>
    <div class="note">Free, no card needed. Links expire within 24 hours.</div></form></div>`;
}

async function load() {
  if (!id) return message('Link not found', 'This share link is incomplete.', 'alert');
  try {
    const res = await fetch(`/public/files/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (res.status === 410) return message('This link has expired', 'Files are deleted for good once their timer ends.');
    if (!res.ok) return message('File not found', data.message || 'It may have been deleted by its owner.', 'alert');
    file = data.file;
    render();
    timer = setInterval(tick, 1000);
  } catch {
    message('Something went wrong', 'Please try again in a moment.', 'alert');
  }
}

function render() {
  const left = file.maxDownloads ? Math.max(0, file.maxDownloads - file.downloads) : null;
  document.title = `${file.name} · Sharebox`;
  root.innerHTML = `<div class="share-card beam fade-up">
    <div class="top">
      ${fileIcon(file.name)}
      <h1>${esc(file.name)}</h1>
      <p class="muted" style="margin-top:6px">${formatBytes(file.size)} · ${esc(file.contentType || 'file')}</p>
      ${file.message ? `<blockquote class="sender-note">${icon('message', 14)}<span>${esc(file.message)}</span></blockquote>` : ''}
    </div>
    <div class="lifebar"><span id="life"></span></div>
    <div class="meta">
      <div>Expires in<b id="exp">${clock(file.expiresAt - Date.now())}</b></div>
      <div>Downloads<b>${file.downloads}</b></div>
      <div>${left == null ? 'Limit' : 'Left'}<b>${left == null ? 'None' : left}</b></div>
    </div>
    <form id="dl-form">
      ${file.passwordProtected ? `<label class="field"><span class="label">${icon('lock', 13)} Password protected</span>
        <input class="input" id="pw" type="password" placeholder="Enter the password" required autocomplete="off"></label>` : ''}
      <div class="alert hidden" id="err"></div>
      <button class="btn btn-dark" id="dl" type="submit">${icon('download', 17)}Download</button>
      <div class="note">${icon('shield', 13)} Delivered over a short-lived signed link. No account needed.</div>
    </form>
  </div>`;
  $('#dl-form').onsubmit = download;
  tick();
}

function tick() {
  const left = file.expiresAt - Date.now();
  const total = file.createdAt ? file.expiresAt - file.createdAt : DAY;
  $('#exp') && ($('#exp').textContent = clock(left));
  $('#life') && ($('#life').style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`);
  if (left <= 0) message('This link has expired', 'Files are deleted for good once their timer ends.');
}

async function download(e) {
  e.preventDefault();
  const btn = $('#dl');
  const err = $('#err');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner light"></span>Preparing…';
  err.classList.add('hidden');
  try {
    const res = await fetch(`/public/files/${encodeURIComponent(id)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('#pw')?.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 410) return message('No longer available', data.message || 'This link has expired.');
    if (!res.ok) throw new Error(data.message || 'Download failed');
    location.assign(data.url); // short-lived presigned S3 URL
    file.downloads = data.downloads ?? file.downloads + 1;
    setTimeout(() => {
      render();
      $('#dl').innerHTML = `${icon('check', 17)}Downloaded. Download again`;
    }, 600);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = `${icon('download', 17)}Download`;
  }
}

load();
