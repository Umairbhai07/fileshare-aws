import { $, esc, formatBytes, countdown, timeAgo, ext, shareUrl, copy, toast, icon } from './util.js';
import { auth } from './auth.js';
import { api, putWithProgress } from './api.js';

const HOUR = 3600_000;
const state = { view: 'overview', files: [], stats: null, queue: [], search: '', servedBy: null, loaded: false };
const views = {
  overview: { title: 'Overview', icon: 'grid' },
  files: { title: 'My files', icon: 'files' },
  usage: { title: 'Usage', icon: 'chart' },
};

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    await auth.handleCallback();
  } catch {
    toast('Sign-in failed, please try again', 'error');
  }
  if (!(await auth.isSignedIn())) return renderLanding();
  renderShell();
  window.addEventListener('hashchange', route);
  route();
  await refresh();
  setInterval(tick, 1000);
  setInterval(() => document.visibilityState === 'visible' && refresh(true), 30_000);
}

function renderLanding() {
  document.body.innerHTML = `
    <div class="center-page">
      <header><a class="brand" href="/"><span class="brand-mark">${icon('upload')}</span>Sharebox</a><span style="flex:1"></span>
        <button class="btn btn-ghost" id="signin">Sign in</button></header>
      <main><div class="hero">
        <span class="badge blue" style="margin-bottom:16px">Files expire automatically</span>
        <h1>Send big files with a link that cleans up after itself.</h1>
        <p>Upload straight to S3, share a link, protect it with a password, and watch the downloads. Everything is gone within 24 hours.</p>
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="btn btn-primary btn-lg" id="signup">Get started free</button>
          <button class="btn btn-lg" id="signin2">Sign in</button>
        </div>
        <div class="features">
          <div><strong>Up to 2 GB</strong>Direct to S3 with live progress.</div>
          <div><strong>Auto-expiry</strong>1, 6, 12 or 24 hours. Then it's deleted.</div>
          <div><strong>Private links</strong>Optional password and download limit.</div>
        </div>
      </div></main>
      <footer><span>Sharebox</span><span>Runs on AWS: CloudFront, S3, EC2, Lambda, DynamoDB</span></footer>
    </div>`;
  $('#signin').onclick = $('#signin2').onclick = () => auth.login();
  $('#signup').onclick = () => auth.login(true);
}

function renderShell() {
  const user = auth.user();
  document.body.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="#/overview"><span class="brand-mark">${icon('upload')}</span>Sharebox</a>
        ${Object.entries(views).map(([k, v]) => `<a class="nav-item" data-view="${k}" href="#/${k}">${icon(v.icon)}<span>${v.title}</span>${k === 'files' ? '<span class="nav-count" id="nav-count"></span>' : ''}</a>`).join('')}
        <div class="sidebar-foot">
          <div class="quota-mini" id="quota-mini"></div>
          <div class="user-row"><span class="avatar">${esc(user.email.slice(0, 2).toUpperCase())}</span><span class="email" title="${esc(user.email)}">${esc(user.email)}</span>
            <button class="btn btn-ghost btn-icon" id="logout" title="Sign out">${icon('logout')}</button></div>
        </div>
      </aside>
      <div class="main">
        <div class="topbar"><h1 id="title"></h1><span class="spacer"></span>
          <span class="muted mono hide-sm" id="served-by" title="The EC2 instance and Availability Zone that served your last API call (via the ALB)"></span>
          <button class="btn btn-primary" id="top-upload">${icon('upload')}Upload</button></div>
        <div class="content" id="content"></div>
      </div>
    </div>
    <input type="file" id="file-input" multiple hidden>`;
  $('#logout').onclick = () => auth.logout();
  $('#top-upload').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => { startUploads([...e.target.files]); e.target.value = ''; };
  // Drop anywhere on the page
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) startUploads([...e.dataTransfer.files]); });
}

function route() {
  const v = location.hash.replace('#/', '');
  state.view = views[v] ? v : 'overview';
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  $('#title').textContent = views[state.view].title;
  renderView();
}

async function refresh(silent = false) {
  try {
    const [{ files }, stats, me] = await Promise.all([api('/api/files'), api('/api/stats'), state.servedBy ? null : api('/api/me')]);
    state.files = files;
    state.stats = stats;
    if (me) state.servedBy = me.servedBy;
    state.loaded = true;
    renderView();
  } catch (err) {
    if (!silent) toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- views
function renderView() {
  const el = $('#content');
  if (!el) return;
  const s = state.stats;
  $('#nav-count').textContent = state.files.length || '';
  if (s) $('#quota-mini').innerHTML = `${formatBytes(s.activeBytes)} of ${formatBytes(s.quotaBytes)}<div class="meter" style="height:4px;margin:6px 0 0"><span style="width:${Math.min(100, (s.activeBytes / s.quotaBytes) * 100)}%"></span></div>`;
  if (state.servedBy) $('#served-by').textContent = `${state.servedBy.instance} · ${state.servedBy.az}`;

  if (state.view === 'overview') {
    el.innerHTML = `
      <div class="section">${statsRow()}</div>
      <div class="section">${uploadCard()}</div>
      <div class="section">
        <div class="section-head"><h2>Recent files</h2><a class="btn btn-ghost" href="#/files">View all</a></div>
        ${filesTable(state.files.slice(0, 6))}
      </div>`;
    bindUpload();
  } else if (state.view === 'files') {
    el.innerHTML = `
      <div class="section">
        <div class="section-head">
          <div style="display:flex;gap:8px;align-items:center;flex:1;max-width:360px">
            <input class="input" id="search" placeholder="Search files…" value="${esc(state.search)}" style="flex:1">
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" id="refresh">${icon('refresh')}Refresh</button>
          </div>
        </div>
        <div id="files-table">${filesTable(filtered())}</div>
      </div>`;
    $('#search').oninput = (e) => { state.search = e.target.value; $('#files-table').innerHTML = filesTable(filtered()); };
    $('#refresh').onclick = () => refresh();
  } else {
    el.innerHTML = usageView();
  }
  bindRowActions(el);
  tick();
}

const filtered = () => state.files.filter((f) => f.name.toLowerCase().includes(state.search.toLowerCase()));

function statsRow() {
  const s = state.stats;
  const v = (x) => (s ? x : '–');
  return `<div class="stats">
    <div class="stat"><div class="stat-label">${icon('files')}Active files</div><div class="stat-value">${v(s?.activeFiles)}</div><div class="stat-sub">${v(s?.protectedFiles)} password protected</div></div>
    <div class="stat"><div class="stat-label">${icon('hdd')}Storage used</div><div class="stat-value">${v(formatBytes(s?.activeBytes))}</div><div class="stat-sub">of ${v(formatBytes(s?.quotaBytes))}</div></div>
    <div class="stat"><div class="stat-label">${icon('download')}Downloads</div><div class="stat-value">${v(s?.activeDownloads)}</div><div class="stat-sub">${v(s?.lifetime.downloads)} all time</div></div>
    <div class="stat"><div class="stat-label">${icon('clock')}Expiring soon</div><div class="stat-value">${v(s?.expiringSoon)}</div><div class="stat-sub">in the next 3 hours</div></div>
  </div>`;
}

function uploadCard() {
  return `<div class="card">
    <div class="upload-card">
      <div class="dropzone" id="dropzone" tabindex="0" role="button">
        <div class="icon-wrap">${icon('upload')}</div>
        <div><strong>Drop files here</strong> or click to browse</div>
        <div class="muted" style="font-size:12.5px">Up to 2 GB per file. Uploads go straight to S3.</div>
      </div>
      <div class="upload-options">
        <label class="field"><span>Link expires after</span>
          <select class="select" id="opt-expiry"><option value="1">1 hour</option><option value="6">6 hours</option><option value="12">12 hours</option><option value="24" selected>24 hours</option></select>
        </label>
        <label class="field"><span>Password <span class="muted" style="font-weight:400">· optional</span></span>
          <input class="input" id="opt-password" type="password" placeholder="No password" autocomplete="new-password">
        </label>
        <label class="field"><span>Download limit <span class="muted" style="font-weight:400">· optional</span></span>
          <input class="input" id="opt-max" type="number" min="0" max="1000" placeholder="Unlimited">
        </label>
      </div>
    </div>
    <div class="queue ${state.queue.length ? '' : 'hidden'}" id="queue">${state.queue.map(queueItem).join('')}</div>
  </div>`;
}

function bindUpload() {
  const dz = $('#dropzone');
  dz.onclick = () => $('#file-input').click();
  dz.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && $('#file-input').click();
  dz.ondragenter = dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = () => dz.classList.remove('drag');
}

function fileIcon(name) {
  return `<span class="file-icon">${esc(ext(name).slice(0, 4))}</span>`;
}

function statusBadge(f) {
  switch (f.status) {
    case 'ready': return '<span class="badge green"><span class="dot"></span>Live</span>';
    case 'pending': return '<span class="badge amber"><span class="dot"></span>Uploading</span>';
    case 'limit_reached': return '<span class="badge red"><span class="dot"></span>Limit reached</span>';
    default: return '<span class="badge"><span class="dot"></span>Expired</span>';
  }
}

function filesTable(files) {
  if (!state.loaded) return `<div class="table-wrap"><div class="empty"><div class="spinner" style="margin:0 auto"></div></div></div>`;
  if (!files.length) {
    return `<div class="table-wrap"><div class="empty"><strong>${state.search ? 'No matching files' : 'No files yet'}</strong>${state.search ? 'Try a different search.' : 'Upload a file to get a share link. It expires on its own.'}</div></div>`;
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th>File</th><th>Status</th><th>Expires in</th><th>Downloads</th><th class="hide-sm">Access</th><th></th></tr></thead>
    <tbody>${files.map((f) => `
      <tr data-id="${esc(f.id)}">
        <td><div class="file-cell">${fileIcon(f.name)}<div style="min-width:0"><div class="file-name" title="${esc(f.name)}">${esc(f.name)}</div><div class="file-sub">${formatBytes(f.size)} · ${timeAgo(f.createdAt)}</div></div></div></td>
        <td>${statusBadge(f)}</td>
        <td><div class="expiry" data-expires="${f.expiresAt}" data-created="${f.createdAt}"><span class="t"></span><div class="bar"><span></span></div></div></td>
        <td class="num">${f.downloads}${f.maxDownloads ? `<span class="muted"> / ${f.maxDownloads}</span>` : ''}</td>
        <td class="hide-sm">${f.passwordProtected ? `<span class="badge">${icon('lock').replace('<svg', '<svg width="12" height="12"')}Password</span>` : '<span class="muted">Anyone with link</span>'}</td>
        <td><div class="actions">
          <button class="btn btn-ghost btn-icon" data-act="copy" title="Copy share link" ${f.status === 'pending' ? 'disabled' : ''}>${icon('link')}</button>
          <a class="btn btn-ghost btn-icon" href="/d/${esc(f.id)}" target="_blank" rel="noopener" title="Open share page">${icon('external')}</a>
          <button class="btn btn-ghost btn-icon btn-danger" data-act="delete" title="Delete now">${icon('trash')}</button>
        </div></td>
      </tr>`).join('')}</tbody></table></div>`;
}

function bindRowActions(root) {
  root.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('[data-id]')?.dataset.id;
    if (btn.dataset.act === 'copy') {
      await copy(shareUrl(id));
      toast('Share link copied');
    } else if (btn.dataset.act === 'delete') {
      const f = state.files.find((x) => x.id === id);
      if (!confirm(`Delete "${f?.name}" now? The link will stop working.`)) return;
      btn.disabled = true;
      try {
        await api(`/api/files/${id}`, { method: 'DELETE' });
        state.files = state.files.filter((x) => x.id !== id);
        toast('File deleted');
        refresh(true);
        renderView();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    } else if (btn.dataset.act === 'copy-queue') {
      await copy(shareUrl(btn.dataset.share));
      toast('Share link copied');
    }
  };
}

function usageView() {
  const s = state.stats;
  if (!s) return `<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>`;
  const max = Math.max(1, ...s.hourly.map((h) => h.uploads));
  const types = Object.entries(s.byType).sort((a, b) => b[1] - a[1]);
  const pct = Math.min(100, (s.activeBytes / s.quotaBytes) * 100);
  return `
    <div class="section">${statsRow()}</div>
    <div class="section grid-2">
      <div class="card card-pad">
        <p class="card-title">Uploads, last 24 hours</p><div class="muted" style="font-size:12.5px">${s.hourly.reduce((a, h) => a + h.uploads, 0)} uploads, ${formatBytes(s.hourly.reduce((a, h) => a + h.bytes, 0))}</div>
        <div class="chart">${s.hourly.map((h) => `<div class="col ${h.uploads ? '' : 'zero'}" style="height:${h.uploads ? Math.max(6, (h.uploads / max) * 100) : 2}%" title="${new Date(h.hourStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${h.uploads} uploads, ${formatBytes(h.bytes)}"></div>`).join('')}</div>
        <div class="chart-axis"><span>24h ago</span><span>12h ago</span><span>Now</span></div>
      </div>
      <div class="card card-pad">
        <p class="card-title">Storage quota</p><div class="muted" style="font-size:12.5px">Live files count toward your quota until they expire.</div>
        <div class="meter"><span style="width:${pct}%"></span></div>
        <div style="font-size:13px"><b>${formatBytes(s.activeBytes)}</b> <span class="muted">of ${formatBytes(s.quotaBytes)} (${pct.toFixed(1)}%)</span></div>
        <div style="margin-top:14px">
          <div class="kv"><span>Live files</span><span>${s.activeFiles}</span></div>
          <div class="kv"><span>Password protected</span><span>${s.protectedFiles}</span></div>
          <div class="kv"><span>Expiring in 3 hours</span><span>${s.expiringSoon}</span></div>
        </div>
      </div>
    </div>
    <div class="section grid-2">
      <div class="card card-pad">
        <p class="card-title">Storage by type</p>
        ${types.length ? types.map(([t, b]) => `<div class="kv" style="display:block"><div style="display:flex;justify-content:space-between"><span style="text-transform:capitalize">${esc(t)}</span><span>${formatBytes(b)}</span></div><div class="meter" style="height:4px;margin:6px 0 0"><span style="width:${(b / Math.max(1, s.activeBytes)) * 100}%;background:var(--accent)"></span></div></div>`).join('') : '<div class="muted" style="padding-top:10px">Nothing stored right now.</div>'}
      </div>
      <div class="card card-pad">
        <p class="card-title">All time</p>
        <div class="kv"><span>Files shared</span><span>${s.lifetime.uploads}</span></div>
        <div class="kv"><span>Data shared</span><span>${formatBytes(s.lifetime.bytes)}</span></div>
        <div class="kv"><span>Downloads</span><span>${s.lifetime.downloads}</span></div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- uploads
let uid = 0;
function queueItem(q) {
  const pct = q.size ? Math.round((q.loaded / q.size) * 100) : 0;
  const speed = q.status === 'uploading' && q.speed ? `${formatBytes(q.speed)}/s` : '';
  const eta = q.status === 'uploading' && q.speed ? `${countdown(((q.size - q.loaded) / q.speed) * 1000)} left` : '';
  return `<div class="queue-item" data-uid="${q.uid}">
    ${fileIcon(q.name)}
    <div style="min-width:0">
      <div class="file-name">${esc(q.name)}</div>
      <div class="queue-meta">
        <span>${q.status === 'error' ? `<span class="error-text">${esc(q.error)}</span>` : q.status === 'done' ? `${formatBytes(q.size)} · ready to share` : `${formatBytes(q.loaded)} of ${formatBytes(q.size)}`}</span>
        <span>${speed}</span><span>${eta}</span>
      </div>
      <div class="progress ${q.status === 'done' ? 'done' : q.status === 'error' ? 'error' : ''}"><span style="width:${q.status === 'error' ? 100 : pct}%"></span></div>
    </div>
    <div>${q.status === 'done'
      ? `<button class="btn" data-act="copy-queue" data-share="${esc(q.shareId)}">${icon('link')}Copy link</button>`
      : q.status === 'error' ? '' : `<span class="mono muted">${pct}%</span>`}</div>
  </div>`;
}

function paintQueueItem(q) {
  const box = $('#queue');
  if (!box) return;
  box.classList.toggle('hidden', !state.queue.length);
  const html = queueItem(q);
  const existing = box.querySelector(`[data-uid="${q.uid}"]`);
  if (existing) existing.outerHTML = html; else box.insertAdjacentHTML('afterbegin', html);
}

function startUploads(files) {
  if (!files.length) return;
  if (state.view !== 'overview') location.hash = '#/overview';
  const opts = {
    expiresInHours: Number($('#opt-expiry')?.value || 24),
    password: $('#opt-password')?.value || undefined,
    maxDownloads: $('#opt-max')?.value ? Number($('#opt-max').value) : 0,
  };
  const items = files.map((file) => ({ uid: ++uid, file, name: file.name, size: file.size, loaded: 0, status: 'queued' }));
  state.queue.unshift(...items);
  items.forEach(paintQueueItem);
  // Up to 3 parallel uploads
  const pending = [...items];
  const worker = async () => { while (pending.length) await uploadOne(pending.shift(), opts); };
  Promise.all([worker(), worker(), worker()]).then(() => refresh(true));
}

async function uploadOne(q, opts) {
  const contentType = q.file.type || 'application/octet-stream';
  try {
    if (q.size === 0) throw new Error('Empty files cannot be shared');
    q.status = 'uploading';
    paintQueueItem(q);
    const { file, uploadUrl } = await api('/api/files', { method: 'POST', body: { name: q.name, size: q.size, contentType, ...opts } });
    q.shareId = file.id;
    const t0 = performance.now();
    let lastPaint = 0;
    await putWithProgress(uploadUrl, q.file, contentType, (loaded) => {
      q.loaded = loaded;
      q.speed = loaded / Math.max(0.001, (performance.now() - t0) / 1000);
      if (performance.now() - lastPaint > 120) { lastPaint = performance.now(); paintQueueItem(q); }
    });
    q.loaded = q.size;
    // The S3 event Lambda marks the file ready too; this call makes the UI instant.
    await api(`/api/files/${file.id}/complete`, { method: 'POST' }).catch(() => {});
    q.status = 'done';
    toast(`${q.name} is ready to share`);
  } catch (err) {
    q.status = 'error';
    q.error = err.message;
  }
  paintQueueItem(q);
}

// ---------------------------------------------------------------- countdown ticker
function tick() {
  const now = Date.now();
  document.querySelectorAll('[data-expires]').forEach((el) => {
    const exp = Number(el.dataset.expires);
    const total = exp - Number(el.dataset.created);
    const left = exp - now;
    el.querySelector('.t').textContent = countdown(left);
    el.querySelector('.bar span').style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
    el.classList.toggle('soon', left < 3 * HOUR);
  });
}

boot();
