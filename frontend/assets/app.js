import { $, $$, esc, formatBytes, countdown, timeAgo, fmtTime, fileIcon, shareUrl, initials, copy, toast, confirmDialog, qrSvg, icon, logoHtml } from './util.js';
import { auth } from './auth.js';
import { api, putWithProgress } from './api.js';

const HOUR = 3600_000;
const EXPIRY = [1, 6, 12, 24];
const VIEWS = {
  overview: { title: 'Overview', icon: 'grid' },
  files: { title: 'My files', icon: 'files' },
  activity: { title: 'Activity', icon: 'activity' },
  usage: { title: 'Usage', icon: 'chart' },
  settings: { title: 'Settings', icon: 'settings' },
};

const prefs = (() => {
  try { return { expiry: 24, maxDownloads: 0, ...JSON.parse(localStorage.getItem('sharebox.prefs')) }; } catch { return { expiry: 24, maxDownloads: 0 }; }
})();
const savePrefs = () => { try { localStorage.setItem('sharebox.prefs', JSON.stringify(prefs)); } catch { /* private mode */ } };

const state = {
  view: 'overview', files: [], stats: null, servedBy: null, loaded: false,
  queue: [], search: '', filter: 'all', sort: 'newest', selected: new Set(), drawerId: null,
  opts: { expiresInHours: prefs.expiry, password: '', maxDownloads: prefs.maxDownloads || '', message: '' },
};
const user = () => auth.user();
const byId = (id) => state.files.find((f) => f.id === id);

// ============================================================================ boot
(async function boot() {
  if (!(await auth.isSignedIn())) return location.replace(`/login?next=${encodeURIComponent('/app' + location.hash)}`);
  renderShell();
  window.addEventListener('hashchange', route);
  route();
  await refresh();
  if (new URLSearchParams(location.search).get('welcome')) {
    toast(`Welcome to Sharebox, ${user().name.split(' ')[0]}`);
    history.replaceState(null, '', '/app' + location.hash);
  }
  setInterval(tick, 1000);
  setInterval(() => document.visibilityState === 'visible' && refresh(true), 20_000);
})();

function renderShell() {
  const u = user();
  document.body.innerHTML = `
  <div class="app">
    <aside class="side" id="side">
      ${logoHtml()}
      <p class="side-label">Workspace</p>
      ${Object.entries(VIEWS).filter(([k]) => k !== 'settings').map(([k, v]) => `<a class="nav" data-view="${k}" href="#/${k}">${icon(v.icon)}<span>${v.title}</span>${k === 'files' ? '<span class="count" id="nav-count"></span>' : ''}</a>`).join('')}
      <p class="side-label">Account</p>
      <a class="nav" data-view="settings" href="#/settings">${icon('settings')}<span>Settings</span></a>
      <a class="nav" href="/" target="_blank" rel="noopener">${icon('external')}<span>Home page</span></a>
      <div class="side-foot">
        <div class="quota" id="quota"><div class="t"><span>Storage</span><b>—</b></div><div class="bar"><span style="--w:0%"></span></div><span class="subtle">of 10 GB</span></div>
        <div class="me"><span class="avatar">${esc(initials(u.name))}</span><div class="who"><p>${esc(u.name)}</p><small>${esc(u.email)}</small></div>
          <button class="btn btn-ghost btn-icon" id="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button></div>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <button class="btn btn-ghost btn-icon menu-btn" id="menu" aria-label="Open menu">${icon('menu')}</button>
        <p class="crumbs">Sharebox / <b id="crumb">Overview</b></p>
        <span class="grow"></span>
        <label class="search"><span class="sr-only">Search files</span>${icon('search')}<input class="input" id="gsearch" placeholder="Search files" autocomplete="off"><span class="kbd">/</span></label>
        <span class="served hide-sm" id="served" title="The EC2 instance and Availability Zone that answered your last request (through the load balancer)"></span>
        <button class="btn btn-dark" id="top-upload">${icon('upload')}<span class="hide-sm">Upload</span></button>
      </div>
      <main class="content" id="content"></main>
    </div>
  </div>
  <input type="file" id="file-input" multiple hidden>`;

  $('#logout').onclick = () => auth.signOut();
  $('#top-upload').onclick = pickFiles;
  $('#file-input').onchange = (e) => { startUploads([...e.target.files]); e.target.value = ''; };
  $('#menu').onclick = () => toggleSide(true);
  $('#gsearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.view !== 'files') location.hash = '#/files';
    else renderFilesTable();
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    $('.drop')?.classList.remove('drag');
    if (e.dataTransfer?.files?.length) startUploads([...e.dataTransfer.files]);
  });
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') { closeDrawer(); toggleSide(false); closeMenu(); }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); $('#gsearch').focus(); }
    if (e.key === 'u') pickFiles();
    if (e.key === 'g') location.hash = '#/overview';
    if (e.key === 'f') location.hash = '#/files';
  });
  document.addEventListener('click', onClick);
}

function toggleSide(open) {
  $('#side').classList.toggle('open', open);
  $('.side-scrim')?.remove();
  if (open) {
    const s = Object.assign(document.createElement('div'), { className: 'scrim side-scrim' });
    s.style.zIndex = 25;
    s.onclick = () => toggleSide(false);
    document.body.append(s);
  }
}

function route() {
  const v = location.hash.replace('#/', '').split('?')[0];
  state.view = VIEWS[v] ? v : 'overview';
  $$('.nav[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  $('#crumb').textContent = VIEWS[state.view].title;
  document.title = `${VIEWS[state.view].title} · Sharebox`;
  toggleSide(false);
  renderView(true);
}

async function refresh(silent = false) {
  try {
    const [{ files }, stats, me] = await Promise.all([api('/api/files'), api('/api/stats'), api('/api/me')]);
    state.files = files;
    state.stats = stats;
    state.servedBy = me.servedBy;
    state.loaded = true;
    for (const id of [...state.selected]) if (!byId(id)) state.selected.delete(id);
    renderView(false);
    if (state.drawerId) byId(state.drawerId) ? renderDrawer() : closeDrawer();
  } catch (err) {
    if (!silent) toast(err.message, 'error');
  }
}

// ============================================================================ views
function renderView(animate) {
  const el = $('#content');
  if (!el) return;
  const s = state.stats;
  $('#nav-count').textContent = state.files.length || '';
  if (s) {
    const pct = Math.min(100, (s.activeBytes / s.quotaBytes) * 100);
    $('#quota').innerHTML = `<div class="t"><span>Storage</span><b>${formatBytes(s.activeBytes)}</b></div><div class="bar"><span style="--w:${Math.max(pct, 0.5)}%"></span></div><span class="subtle">${pct.toFixed(1)}% of ${formatBytes(s.quotaBytes)}</span>`;
  }
  if (state.servedBy) $('#served').innerHTML = `<i></i>${esc(state.servedBy.instance)} · ${esc(state.servedBy.az)}`;

  // Keep focus and upload option values stable on background refreshes
  if (!animate && state.view === 'overview' && $('#upload-card')) {
    $('#kpis').outerHTML = kpis();
    $('#recent').innerHTML = recentCard();
    $('#side-col').innerHTML = sideCol();
    return tick();
  }
  if (!animate && state.view === 'files' && $('#files-card')) { renderFilesTable(); return; }

  el.style.animation = 'none';
  void el.offsetHeight;
  el.style.animation = '';
  el.innerHTML = { overview: overviewView, files: filesView, activity: activityView, usage: usageView, settings: settingsView }[state.view]();
  if (state.view === 'overview') bindUpload();
  if (state.view === 'files') bindFiles();
  if (state.view === 'settings') bindSettings();
  tick();
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function kpis() {
  const s = state.stats;
  const v = (x) => (s ? x : '<span class="skeleton" style="display:inline-block;width:60px;height:28px"></span>');
  return `<div class="kpis stagger" id="kpis">
    <div class="kpi"><div class="h"><span>Live files</span><span class="ic">${icon('files')}</span></div><p class="v">${v(s?.activeFiles)}</p><p class="s">${s ? `${s.protectedFiles} password protected` : '&nbsp;'}</p></div>
    <div class="kpi"><div class="h"><span>Storage used</span><span class="ic">${icon('hdd')}</span></div><p class="v">${v(formatBytes(s?.activeBytes))}</p><p class="s">${s ? `of ${formatBytes(s.quotaBytes)}` : '&nbsp;'}</p></div>
    <div class="kpi"><div class="h"><span>Downloads</span><span class="ic">${icon('download')}</span></div><p class="v">${v(s?.activeDownloads)}</p><p class="s">${s ? `${s.lifetime.downloads} all time` : '&nbsp;'}</p></div>
    <div class="kpi"><div class="h"><span>Expiring soon</span><span class="ic">${icon('timer')}</span></div><p class="v">${v(s?.expiringSoon)}</p><p class="s">in the next 3 hours</p></div>
  </div>`;
}

function overviewView() {
  const first = esc(user().name.split(' ')[0]);
  return `
    <div class="page-head"><div><h1>${greeting()}, ${first}</h1><p>Here's what's happening with your shared files.</p></div>
      <div style="display:flex;gap:8px"><a class="btn" href="#/files">${icon('files')}All files</a><button class="btn btn-dark" data-act="pick">${icon('plus')}New upload</button></div></div>
    ${kpis()}
    <div class="grid-main">
      <div class="gap">
        ${uploadCard()}
        <div class="card" id="recent">${recentCard()}</div>
      </div>
      <div class="gap" id="side-col">${sideCol()}</div>
    </div>`;
}

function uploadCard() {
  const o = state.opts;
  const active = state.queue.some((q) => q.status === 'uploading');
  return `<div class="card beam beam-off ${active ? 'is-active beam-fast' : ''}" id="upload-card">
    <div class="card-head"><h2>Upload files</h2><span class="subtle" style="font-size:12.5px">Press <span class="kbd">U</span> anywhere</span></div>
    <div class="upload-grid">
      <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose files to upload">
        <div class="ic">${icon('upload')}</div>
        <div><strong>Drop files here</strong> <span class="muted">or click to browse</span></div>
        <p class="muted">Up to 2 GB each. Files go straight to encrypted S3 storage.</p>
      </div>
      <div class="upload-opts">
        <div><label class="label">Link expires after</label>
          <div class="seg" id="seg-exp">${EXPIRY.map((h) => `<button type="button" data-h="${h}" class="${o.expiresInHours === h ? 'on' : ''}">${h}h</button>`).join('')}</div></div>
        <div><label class="label" for="opt-pw">Password <span class="subtle" style="font-weight:400">optional</span></label>
          <input class="input" id="opt-pw" type="password" placeholder="No password" autocomplete="new-password" value="${esc(o.password)}"></div>
        <div><label class="label" for="opt-max">Download limit <span class="subtle" style="font-weight:400">optional</span></label>
          <input class="input" id="opt-max" type="number" min="0" max="1000" placeholder="Unlimited" value="${esc(o.maxDownloads || '')}"></div>
        <div><label class="label" for="opt-msg">Note for recipient <span class="subtle" style="font-weight:400">optional</span></label>
          <input class="input" id="opt-msg" maxlength="500" placeholder="Here are the files we discussed" value="${esc(o.message)}"></div>
      </div>
    </div>
    <div class="queue ${state.queue.length ? '' : 'hidden'}" id="queue">${state.queue.map(queueItem).join('')}</div>
  </div>`;
}

function bindUpload() {
  const dz = $('#drop');
  dz.onclick = pickFiles;
  dz.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pickFiles());
  dz.ondragenter = dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); $('#upload-card').classList.add('is-active'); };
  dz.ondragleave = () => { dz.classList.remove('drag'); if (!state.queue.some((q) => q.status === 'uploading')) $('#upload-card').classList.remove('is-active'); };
  $('#seg-exp').onclick = (e) => {
    const b = e.target.closest('[data-h]');
    if (!b) return;
    state.opts.expiresInHours = Number(b.dataset.h);
    $$('#seg-exp button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#opt-pw').oninput = (e) => { state.opts.password = e.target.value; };
  $('#opt-max').oninput = (e) => { state.opts.maxDownloads = e.target.value; };
  $('#opt-msg').oninput = (e) => { state.opts.message = e.target.value; };
}

function recentCard() {
  return `<div class="card-head"><h2>Recent files</h2><a class="btn btn-ghost btn-sm" href="#/files">View all ${icon('arrowRight')}</a></div>${table(state.files.slice(0, 6), { compact: true })}`;
}

function sideCol() {
  const now = Date.now();
  const soon = state.files.filter((f) => f.status !== 'pending').sort((a, b) => a.expiresAt - b.expiresAt).slice(0, 4);
  return `
    <div class="card">
      <div class="card-head"><h2>Expiring soon</h2><span class="badge">${state.stats?.expiringSoon ?? 0} in 3h</span></div>
      ${soon.length ? soon.map((f) => `<div class="list-item" data-open="${esc(f.id)}">${fileIcon(f.name)}<div class="grow"><p>${esc(f.name)}</p><small class="num" data-exp="${f.expiresAt}" data-created="${f.createdAt}" data-fmt="text">${countdown(f.expiresAt - now)}</small></div>${icon('arrowRight', 14)}</div>`).join('') : emptyMini('Nothing is about to expire.')}
    </div>
    <div class="card">
      <div class="card-head"><h2>Recent activity</h2><a class="btn btn-ghost btn-sm" href="#/activity">All ${icon('arrowRight')}</a></div>
      ${timeline(events().slice(0, 5)) || emptyMini('Activity shows up here once you share a file.')}
    </div>`;
}

const emptyMini = (t) => `<p class="muted" style="padding:18px;font-size:13.5px">${t}</p>`;

function statusBadge(f) {
  switch (f.status) {
    case 'ready': return '<span class="badge green"><span class="dot"></span>Live</span>';
    case 'pending': return '<span class="badge amber"><span class="dot"></span>Uploading</span>';
    case 'limit_reached': return '<span class="badge red"><span class="dot"></span>Limit reached</span>';
    default: return '<span class="badge"><span class="dot"></span>Expired</span>';
  }
}

function table(files, { compact = false, selectable = false } = {}) {
  if (!state.loaded) {
    return `<div style="padding:16px;display:flex;flex-direction:column;gap:10px">${'<div class="skeleton" style="height:38px"></div>'.repeat(4)}</div>`;
  }
  if (!files.length) {
    const filtered = state.search || state.filter !== 'all';
    return `<div class="empty"><div class="ic">${icon(filtered ? 'search' : 'upload')}</div><strong>${filtered ? 'No matching files' : 'No files yet'}</strong>
      <p>${filtered ? 'Try another search or filter.' : 'Upload a file to get a share link. It deletes itself when time is up.'}</p>
      ${filtered ? '' : `<button class="btn btn-dark" style="margin-top:16px" data-act="pick">${icon('upload')}Upload a file</button>`}</div>`;
  }
  const allSel = selectable && files.every((f) => state.selected.has(f.id));
  return `<div class="table-wrap"><table>
    <thead><tr>${selectable ? `<th class="cb"><input type="checkbox" id="sel-all" aria-label="Select all" ${allSel ? 'checked' : ''}></th>` : ''}<th>File</th><th>Status</th><th>Expires in</th><th>Downloads</th>${compact ? '' : '<th class="hide-sm">Access</th>'}<th></th></tr></thead>
    <tbody class="${compact ? '' : 'stagger'}">${files.map((f) => `
      <tr data-open="${esc(f.id)}" class="${state.selected.has(f.id) ? 'sel' : ''}">
        ${selectable ? `<td class="cb"><input type="checkbox" data-sel="${esc(f.id)}" aria-label="Select ${esc(f.name)}" ${state.selected.has(f.id) ? 'checked' : ''}></td>` : ''}
        <td><div class="fcell">${fileIcon(f.name)}<div style="min-width:0"><p class="nm" title="${esc(f.name)}">${esc(f.name)}</p><small>${formatBytes(f.size)} · ${timeAgo(f.createdAt)}</small></div></div></td>
        <td>${statusBadge(f)}</td>
        <td><div class="exp" data-exp="${f.expiresAt}" data-created="${f.createdAt}"><span class="t"></span><div class="bar"><span></span></div></div></td>
        <td class="dl-cell">${f.downloads}${f.maxDownloads ? `<span class="subtle"> / ${f.maxDownloads}</span>` : ''}</td>
        ${compact ? '' : `<td class="hide-sm"><div style="display:flex;gap:6px">${f.passwordProtected ? `<span class="badge">${icon('lock')}Password</span>` : '<span class="subtle" style="font-size:13px">Anyone with link</span>'}${f.message ? `<span class="badge" title="${esc(f.message)}">${icon('message')}</span>` : ''}</div></td>`}
        <td><div class="acts">
          <button class="btn btn-ghost btn-icon" data-act="copy" data-id="${esc(f.id)}" title="Copy link" ${f.status === 'pending' ? 'disabled' : ''}>${icon('link')}</button>
          <button class="btn btn-ghost btn-icon" data-act="menu" data-id="${esc(f.id)}" title="More" aria-label="More actions">${icon('more')}</button>
        </div></td>
      </tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------- files view
function filtered() {
  const q = state.search.trim().toLowerCase();
  const now = Date.now();
  let list = state.files.filter((f) => !q || f.name.toLowerCase().includes(q));
  if (state.filter === 'live') list = list.filter((f) => f.status === 'ready');
  if (state.filter === 'uploading') list = list.filter((f) => f.status === 'pending');
  if (state.filter === 'protected') list = list.filter((f) => f.passwordProtected);
  if (state.filter === 'expiring') list = list.filter((f) => f.expiresAt - now < 3 * HOUR);
  const sorts = {
    newest: (a, b) => b.createdAt - a.createdAt,
    expiring: (a, b) => a.expiresAt - b.expiresAt,
    largest: (a, b) => b.size - a.size,
    downloads: (a, b) => b.downloads - a.downloads,
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return list.sort(sorts[state.sort]);
}

function filesView() {
  const n = state.files.length;
  return `
    <div class="page-head"><div><h1>My files</h1><p>${n} live ${n === 1 ? 'file' : 'files'}. Every file deletes itself when its timer ends.</p></div>
      <div style="display:flex;gap:8px"><button class="btn" data-act="refresh">${icon('refresh')}Refresh</button><button class="btn btn-dark" data-act="pick">${icon('upload')}Upload</button></div></div>
    <div class="card" id="files-card">
      <div class="toolbar">
        <div class="tabs" id="tabs"></div>
        <span style="flex:1"></span>
        <input class="input" id="fsearch" placeholder="Search by name" value="${esc(state.search)}" style="width:220px;height:34px">
        <select class="select" id="fsort" style="width:170px;height:34px" aria-label="Sort">
          ${[['newest', 'Newest first'], ['expiring', 'Expiring first'], ['largest', 'Largest first'], ['downloads', 'Most downloaded'], ['name', 'Name A to Z']].map(([k, l]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div id="bulk"></div>
      <div id="files-table"></div>
    </div>`;
}

function renderFilesTable() {
  const now = Date.now();
  const counts = {
    all: state.files.length,
    live: state.files.filter((f) => f.status === 'ready').length,
    uploading: state.files.filter((f) => f.status === 'pending').length,
    protected: state.files.filter((f) => f.passwordProtected).length,
    expiring: state.files.filter((f) => f.expiresAt - now < 3 * HOUR).length,
  };
  $('#tabs').innerHTML = [['all', 'All'], ['live', 'Live'], ['uploading', 'Uploading'], ['protected', 'Protected'], ['expiring', 'Expiring soon']]
    .map(([k, l]) => `<button data-filter="${k}" class="${state.filter === k ? 'on' : ''}">${l}<small>${counts[k]}</small></button>`).join('');
  const n = state.selected.size;
  $('#bulk').innerHTML = n ? `<div class="bulkbar"><b>${n} selected</b><span style="flex:1"></span>
    <button class="btn btn-ghost btn-sm" data-act="bulk-copy">${icon('link')}Copy links</button>
    <button class="btn btn-ghost btn-sm" data-act="bulk-clear">${icon('x')}Clear</button>
    <button class="btn btn-sm btn-danger" style="background:#fff" data-act="bulk-delete">${icon('trash')}Delete</button></div>` : '';
  $('#files-table').innerHTML = table(filtered(), { selectable: true });
  if ($('#fsearch') && $('#fsearch').value !== state.search) $('#fsearch').value = state.search;
  tick();
}

function bindFiles() {
  renderFilesTable();
  $('#fsearch').oninput = (e) => { state.search = e.target.value; $('#gsearch').value = state.search; renderFilesTable(); };
  $('#fsort').onchange = (e) => { state.sort = e.target.value; renderFilesTable(); };
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-filter]'); if (b) { state.filter = b.dataset.filter; renderFilesTable(); } };
  $('#files-card').addEventListener('change', (e) => {
    if (e.target.id === 'sel-all') {
      filtered().forEach((f) => (e.target.checked ? state.selected.add(f.id) : state.selected.delete(f.id)));
      renderFilesTable();
    } else if (e.target.dataset.sel) {
      e.target.checked ? state.selected.add(e.target.dataset.sel) : state.selected.delete(e.target.dataset.sel);
      renderFilesTable();
    }
  });
  if (state.search) $('#fsearch').focus();
}

// ---------------------------------------------------------------------------- activity
function events() {
  const out = [];
  for (const f of state.files) {
    out.push({ t: f.uploadedAt || f.createdAt, kind: f.status === 'pending' ? 'start' : 'upload', f });
    if (f.lastDownloadAt) out.push({ t: f.lastDownloadAt, kind: 'download', f });
  }
  return out.sort((a, b) => b.t - a.t);
}

function timeline(list) {
  if (!list.length) return '';
  const line = (e) => {
    const n = `<b>${esc(e.f.name)}</b>`;
    if (e.kind === 'download') return [icon('download'), true, `${n} was downloaded <span class="subtle">(${e.f.downloads} total)</span>`];
    if (e.kind === 'start') return [icon('upload'), false, `You started uploading ${n}`];
    return [icon('check'), false, `You shared ${n}${e.f.passwordProtected ? ' with a password' : ''}`];
  };
  return `<div class="timeline">${list.map((e) => {
    const [ic, dark, text] = line(e);
    return `<div class="tl" data-open="${esc(e.f.id)}" style="cursor:pointer"><span class="ic ${dark ? 'dark' : ''}">${ic}</span><p>${text}</p><small>${timeAgo(e.t)}</small></div>`;
  }).join('')}</div>`;
}

function activityView() {
  const ev = events();
  return `
    <div class="page-head"><div><h1>Activity</h1><p>Uploads and downloads across your live files.</p></div></div>
    <div class="grid-main">
      <div class="card"><div class="card-head"><h2>Timeline</h2><span class="subtle" style="font-size:12.5px">${ev.length} events</span></div>
        ${timeline(ev) || `<div class="empty"><div class="ic">${icon('activity')}</div><strong>No activity yet</strong><p>Share a file and every download will show up here.</p></div>`}</div>
      <div class="gap">
        <div class="card card-pad"><p class="eyebrow" style="margin-bottom:10px">Top files</p>
          ${[...state.files].sort((a, b) => b.downloads - a.downloads).slice(0, 5).map((f) => `<div class="kv"><span style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span><span>${f.downloads}</span></div>`).join('') || '<p class="muted">No downloads yet.</p>'}
        </div>
        <div class="card card-pad"><p class="eyebrow" style="margin-bottom:10px">All time</p>
          <div class="kv"><span>Files shared</span><span>${state.stats?.lifetime.uploads ?? 0}</span></div>
          <div class="kv"><span>Data shared</span><span>${formatBytes(state.stats?.lifetime.bytes ?? 0)}</span></div>
          <div class="kv"><span>Downloads</span><span>${state.stats?.lifetime.downloads ?? 0}</span></div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------- usage
function usageView() {
  const s = state.stats;
  if (!s) return `${kpis()}<div class="card skeleton" style="height:260px"></div>`;
  const max = Math.max(1, ...s.hourly.map((h) => h.uploads));
  const types = Object.entries(s.byType).sort((a, b) => b[1] - a[1]);
  const pct = Math.min(100, (s.activeBytes / s.quotaBytes) * 100);
  return `
    <div class="page-head"><div><h1>Usage</h1><p>How much you're sharing, and how it's being used.</p></div></div>
    ${kpis()}
    <div class="grid-2" style="margin-bottom:20px">
      <div class="card card-pad">
        <h2 style="font:600 14px var(--font);letter-spacing:0">Uploads, last 24 hours</h2>
        <p class="muted" style="font-size:13px">${s.hourly.reduce((a, h) => a + h.uploads, 0)} uploads · ${formatBytes(s.hourly.reduce((a, h) => a + h.bytes, 0))}</p>
        <div class="chart">${s.hourly.map((h, i) => `<div class="col ${h.uploads ? '' : 'zero'}" style="height:${h.uploads ? Math.max(6, (h.uploads / max) * 100) : 1.5}%;animation-delay:${i * 18}ms" title="${new Date(h.hourStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${h.uploads} uploads, ${formatBytes(h.bytes)}"></div>`).join('')}</div>
        <div class="chart-axis"><span>24h ago</span><span>12h ago</span><span>Now</span></div>
      </div>
      <div class="card card-pad">
        <h2 style="font:600 14px var(--font);letter-spacing:0">Storage quota</h2>
        <p class="muted" style="font-size:13px">Live files count until they expire.</p>
        <div class="meter"><span style="--w:${Math.max(pct, 0.5)}%"></span></div>
        <p style="font-size:13.5px"><b>${formatBytes(s.activeBytes)}</b> <span class="muted">of ${formatBytes(s.quotaBytes)} (${pct.toFixed(1)}%)</span></p>
        <div style="margin-top:14px">
          <div class="kv"><span>Live files</span><span>${s.activeFiles} of 200</span></div>
          <div class="kv"><span>Password protected</span><span>${s.protectedFiles}</span></div>
          <div class="kv"><span>Expiring in 3 hours</span><span>${s.expiringSoon}</span></div>
        </div>
      </div>
    </div>
    <div class="grid-2">
      <div class="card card-pad">
        <h2 style="font:600 14px var(--font);letter-spacing:0;margin-bottom:6px">Storage by type</h2>
        ${types.length ? types.map(([t, b]) => `<div class="kv" style="display:block"><div style="display:flex;justify-content:space-between"><span style="text-transform:capitalize;color:var(--ink)">${esc(t)}</span><span>${formatBytes(b)}</span></div><div class="meter" style="height:4px;margin:8px 0 0"><span style="--w:${(b / Math.max(1, s.activeBytes)) * 100}%"></span></div></div>`).join('') : '<p class="muted">Nothing stored right now.</p>'}
      </div>
      <div class="card card-pad">
        <h2 style="font:600 14px var(--font);letter-spacing:0;margin-bottom:6px">All time</h2>
        <div class="kv"><span>Files shared</span><span>${s.lifetime.uploads}</span></div>
        <div class="kv"><span>Data shared</span><span>${formatBytes(s.lifetime.bytes)}</span></div>
        <div class="kv"><span>Downloads</span><span>${s.lifetime.downloads}</span></div>
        <div class="kv"><span>Average downloads per file</span><span>${s.lifetime.uploads ? (s.lifetime.downloads / s.lifetime.uploads).toFixed(1) : '0'}</span></div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------- settings
function settingsView() {
  const u = user();
  return `
    <div class="page-head"><div><h1>Settings</h1><p>Your account and upload defaults.</p></div></div>
    <div class="grid-2">
      <div class="gap">
        <div class="card"><div class="card-head"><h2>Profile</h2></div>
          <div class="card-pad" style="display:flex;gap:14px;align-items:center"><span class="avatar" style="width:48px;height:48px;font-size:16px">${esc(initials(u.name))}</span>
            <div style="flex:1;min-width:0"><p style="font-weight:600">${esc(u.name)}</p><p class="muted" style="font-size:13.5px">${esc(u.email)}</p></div>
            <button class="btn" data-act="logout">${icon('logout')}Sign out</button></div></div>
        <div class="card"><div class="card-head"><h2>Upload defaults</h2><span class="subtle" style="font-size:12.5px">Saved on this device</span></div>
          <div class="card-pad">
            <label class="label">Default link lifetime</label>
            <div class="seg" id="pref-exp">${EXPIRY.map((h) => `<button type="button" data-h="${h}" class="${prefs.expiry === h ? 'on' : ''}">${h} hours</button>`).join('')}</div>
            <div class="field" style="margin-top:16px"><label class="label" for="pref-max">Default download limit</label>
              <input class="input" id="pref-max" type="number" min="0" max="1000" placeholder="Unlimited" value="${prefs.maxDownloads || ''}"></div>
          </div></div>
        <div class="card" style="border-color:var(--red-line)"><div class="card-head" style="border-color:var(--red-line)"><h2 style="color:var(--red)">Danger zone</h2></div>
          <div class="card-pad" style="display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap"><div><p style="font-weight:600">Delete all files now</p><p class="muted" style="font-size:13.5px">Every link stops working immediately.</p></div>
            <button class="btn btn-danger" data-act="delete-all" ${state.files.length ? '' : 'disabled'}>${icon('trash')}Delete ${state.files.length} files</button></div></div>
      </div>
      <div class="gap">
        <div class="card"><div class="card-head"><h2>Keyboard shortcuts</h2></div>
          <div class="card-pad">
            <div class="kv"><span>Upload files</span><span class="kbd">U</span></div>
            <div class="kv"><span>Search</span><span class="kbd">/</span></div>
            <div class="kv"><span>Go to overview</span><span class="kbd">G</span></div>
            <div class="kv"><span>Go to files</span><span class="kbd">F</span></div>
            <div class="kv"><span>Close panel</span><span class="kbd">Esc</span></div>
          </div></div>
        <div class="card"><div class="card-head"><h2>About this deployment</h2></div>
          <div class="card-pad">
            <div class="kv"><span>Served by</span><span class="mono">${esc(state.servedBy?.instance || '—')}</span></div>
            <div class="kv"><span>Availability Zone</span><span class="mono">${esc(state.servedBy?.az || '—')}</span></div>
            <div class="kv"><span>Version</span><span class="mono">${esc(String(state.servedBy?.version || '—').slice(0, 12))}</span></div>
            <div class="kv"><span>Sign-in</span><span>${auth.isDev ? 'Local demo mode' : 'Amazon Cognito'}</span></div>
          </div></div>
      </div>
    </div>`;
}

function bindSettings() {
  $('#pref-exp').onclick = (e) => {
    const b = e.target.closest('[data-h]');
    if (!b) return;
    prefs.expiry = Number(b.dataset.h);
    state.opts.expiresInHours = prefs.expiry;
    savePrefs();
    $$('#pref-exp button').forEach((x) => x.classList.toggle('on', x === b));
    toast(`New links will last ${prefs.expiry} hours`);
  };
  $('#pref-max').onchange = (e) => {
    prefs.maxDownloads = Math.max(0, Math.min(1000, Number(e.target.value) || 0));
    state.opts.maxDownloads = prefs.maxDownloads || '';
    savePrefs();
    toast(prefs.maxDownloads ? `Default limit set to ${prefs.maxDownloads} downloads` : 'No default download limit');
  };
}

// ============================================================================ drawer
function openDrawer(id) {
  state.drawerId = id;
  closeMenu();
  if (!$('.drawer')) {
    const scrim = Object.assign(document.createElement('div'), { className: 'scrim drawer-scrim' });
    scrim.onclick = closeDrawer;
    const d = Object.assign(document.createElement('aside'), { className: 'drawer' });
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'File details');
    document.body.append(scrim, d);
  }
  renderDrawer();
}

function closeDrawer() {
  state.drawerId = null;
  $('.drawer')?.remove();
  $('.drawer-scrim')?.remove();
}

function renderDrawer() {
  const f = byId(state.drawerId);
  const d = $('.drawer');
  if (!f || !d) return closeDrawer();
  const link = shareUrl(f.id);
  const ready = f.status !== 'pending';
  const isImage = /^image\//.test(f.contentType) && ready;
  const maxExtend = f.createdAt + 24 * HOUR;
  d.innerHTML = `
    <div class="drawer-head">${fileIcon(f.name)}<div class="grow"><h2 id="d-name">${esc(f.name)}</h2>
      <p class="muted" style="font-size:13px;margin-top:2px">${formatBytes(f.size)} · ${esc(f.contentType)}</p><div style="margin-top:8px">${statusBadge(f)}</div></div>
      <button class="btn btn-ghost btn-icon" data-act="close-drawer" aria-label="Close">${icon('x')}</button></div>
    <div class="drawer-body">
      <section class="drawer-sec"><h3>Share link</h3>
        <div class="linkbox"><input readonly value="${esc(link)}" aria-label="Share link"><button class="btn" data-act="copy" data-id="${esc(f.id)}" ${ready ? '' : 'disabled'}>${icon('copy')}Copy</button></div>
        <div class="qr-wrap"><div class="qr" id="qr">${ready ? qrSvg(link) : ''}</div>
          <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start"><p class="muted" style="font-size:13px">Scan to open the download page on a phone.</p>
            <a class="btn btn-sm" href="/d/${esc(f.id)}" target="_blank" rel="noopener">${icon('external')}Open page</a>
            <button class="btn btn-sm" data-act="download-qr" ${ready ? '' : 'disabled'}>${icon('download')}Save QR</button></div></div>
      </section>
      ${isImage ? `<section class="drawer-sec"><h3>Preview</h3><div class="preview-img" id="pv"><span class="spinner"></span></div></section>` : ''}
      <section class="drawer-sec"><h3>Timer</h3>
        <div class="kv"><span>Expires in</span><span class="num" data-exp="${f.expiresAt}" data-created="${f.createdAt}" data-fmt="text">${countdown(f.expiresAt - Date.now())}</span></div>
        <div class="kv"><span>Expires at</span><span>${fmtTime(f.expiresAt)}</span></div>
        <p class="hint" style="margin:10px 0 8px">Extend from now (never past ${fmtTime(maxExtend)}, 24 hours after upload).</p>
        <div class="seg" id="extend">${EXPIRY.map((h) => `<button type="button" data-h="${h}">${h}h</button>`).join('')}</div>
      </section>
      <section class="drawer-sec"><h3>Downloads</h3>
        <div class="kv"><span>Downloads</span><span>${f.downloads}${f.maxDownloads ? ` of ${f.maxDownloads}` : ''}</span></div>
        <div class="kv"><span>Last download</span><span>${f.lastDownloadAt ? timeAgo(f.lastDownloadAt) : 'Not yet'}</span></div>
        <div class="kv"><span>Uploaded</span><span>${fmtTime(f.uploadedAt || f.createdAt)}</span></div>
      </section>
      <section class="drawer-sec"><h3>Settings</h3>
        <form id="d-form" style="display:flex;flex-direction:column;gap:12px">
          <div><label class="label" for="d-rename">Name</label><input class="input" id="d-rename" value="${esc(f.name)}" maxlength="200"></div>
          <div><label class="label" for="d-msg">Note for recipient</label><input class="input" id="d-msg" value="${esc(f.message || '')}" maxlength="500" placeholder="No note"></div>
          <div><label class="label" for="d-max">Download limit</label><input class="input" id="d-max" type="number" min="0" max="1000" value="${f.maxDownloads || ''}" placeholder="Unlimited"></div>
          <div><label class="label" for="d-pw">Password ${f.passwordProtected ? '<span class="badge" style="margin-left:6px">Set</span>' : ''}</label>
            <input class="input" id="d-pw" type="password" autocomplete="new-password" placeholder="${f.passwordProtected ? 'Type a new password to change it' : 'Add a password'}"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-dark" type="submit">${icon('check')}Save changes</button>
            ${f.passwordProtected ? `<button class="btn" type="button" data-act="remove-pw">${icon('unlock')}Remove password</button>` : ''}</div>
        </form>
      </section>
      <section class="drawer-sec"><h3>Danger zone</h3>
        <button class="btn btn-danger" data-act="delete" data-id="${esc(f.id)}">${icon('trash')}Delete now</button>
      </section>
    </div>`;
  if (isImage) {
    api(`/api/files/${f.id}/preview`).then(({ url }) => {
      const pv = $('#pv');
      if (pv) pv.innerHTML = `<img src="${esc(url)}" alt="Preview of ${esc(f.name)}">`;
    }).catch(() => { const pv = $('#pv'); if (pv) pv.innerHTML = '<p class="muted" style="padding:20px">Preview unavailable</p>'; });
  }
  $('#extend').onclick = async (e) => {
    const b = e.target.closest('[data-h]');
    if (b) await patch(f.id, { expiresInHours: Number(b.dataset.h) }, 'Timer updated');
  };
  $('#d-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    const name = $('#d-rename').value.trim();
    if (name && name !== f.name) body.name = name;
    const msg = $('#d-msg').value.trim();
    if (msg !== (f.message || '')) body.message = msg;
    const max = Number($('#d-max').value || 0);
    if (max !== (f.maxDownloads || 0)) body.maxDownloads = max;
    const pw = $('#d-pw').value;
    if (pw) body.password = pw;
    if (!Object.keys(body).length) return toast('Nothing changed');
    await patch(f.id, body, 'Changes saved');
  };
  tick();
}

async function patch(id, body, okMsg) {
  try {
    const { file } = await api(`/api/files/${id}`, { method: 'PATCH', body });
    state.files = state.files.map((x) => (x.id === id ? file : x));
    toast(okMsg);
    renderDrawer();
    renderView(false);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================================ actions
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }

function openMenu(btn, id) {
  closeMenu();
  const f = byId(id);
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  menuEl.innerHTML = `
    <button data-act="details" data-id="${esc(id)}">${icon('edit')}Details and settings</button>
    <button data-act="copy" data-id="${esc(id)}" ${f.status === 'pending' ? 'disabled' : ''}>${icon('link')}Copy link</button>
    <button data-act="qr" data-id="${esc(id)}">${icon('qr')}Show QR code</button>
    <button data-act="open-page" data-id="${esc(id)}">${icon('external')}Open download page</button>
    <hr><button class="danger" data-act="delete" data-id="${esc(id)}">${icon('trash')}Delete now</button>`;
  document.body.append(menuEl);
  const r = btn.getBoundingClientRect();
  const top = Math.min(r.bottom + 4 + window.scrollY, window.scrollY + window.innerHeight - menuEl.offsetHeight - 8);
  menuEl.style.top = `${top}px`;
  menuEl.style.left = `${Math.max(8, r.right - menuEl.offsetWidth + window.scrollX)}px`;
}

async function onClick(e) {
  const actEl = e.target.closest('[data-act]');
  if (!actEl) {
    if (menuEl && !e.target.closest('.menu')) closeMenu();
    if (e.target.closest('input[type=checkbox], .cb')) return;
    const row = e.target.closest('[data-open]');
    if (row && !e.target.closest('a, button')) openDrawer(row.dataset.open);
    return;
  }
  e.stopPropagation();
  const id = actEl.dataset.id;
  const act = actEl.dataset.act;
  if (act !== 'menu') closeMenu();
  switch (act) {
    case 'pick': return pickFiles();
    case 'refresh': await refresh(); return toast('Up to date');
    case 'logout': return auth.signOut();
    case 'menu': return menuEl ? closeMenu() : openMenu(actEl, id);
    case 'details': case 'qr': return openDrawer(id);
    case 'open-page': return window.open(`/d/${id}`, '_blank', 'noopener');
    case 'close-drawer': return closeDrawer();
    case 'copy': await copy(shareUrl(id)); return toast('Link copied');
    case 'copy-queue': await copy(shareUrl(actEl.dataset.share)); return toast('Link copied');
    case 'cancel-upload': {
      const q = state.queue.find((x) => String(x.uid) === actEl.dataset.uid);
      q?.request?.abort();
      return;
    }
    case 'download-qr': {
      const svg = $('#qr svg');
      if (!svg) return;
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' })),
        download: `sharebox-${state.drawerId}.svg`,
      });
      a.click();
      return setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    case 'remove-pw': return patch(state.drawerId, { password: '' }, 'Password removed');
    case 'delete': {
      const f = byId(id);
      if (!(await confirmDialog({ title: 'Delete this file?', text: `"${f?.name}" will be deleted and its link will stop working right away.`, ok: 'Delete', danger: true }))) return;
      try {
        await api(`/api/files/${id}`, { method: 'DELETE' });
        state.files = state.files.filter((x) => x.id !== id);
        state.selected.delete(id);
        if (state.drawerId === id) closeDrawer();
        toast('File deleted');
        renderView(false);
        refresh(true);
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    case 'bulk-clear': state.selected.clear(); return renderFilesTable();
    case 'bulk-copy': {
      const links = [...state.selected].map((x) => byId(x)).filter((f) => f && f.status !== 'pending').map((f) => `${f.name}: ${shareUrl(f.id)}`);
      await copy(links.join('\n'));
      return toast(`${links.length} links copied`);
    }
    case 'bulk-delete': case 'delete-all': {
      const ids = act === 'delete-all' ? state.files.map((f) => f.id) : [...state.selected];
      if (!ids.length) return;
      if (!(await confirmDialog({ title: `Delete ${ids.length} ${ids.length === 1 ? 'file' : 'files'}?`, text: 'Their links stop working right away. This cannot be undone.', ok: 'Delete', danger: true }))) return;
      try {
        const { deleted } = await api('/api/files/bulk-delete', { method: 'POST', body: { ids: ids.slice(0, 100) } });
        state.selected.clear();
        toast(`${deleted} ${deleted === 1 ? 'file' : 'files'} deleted`);
        await refresh(true);
        renderView(true);
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    default:
  }
}

// ============================================================================ uploads
let uid = 0;
function pickFiles() { $('#file-input').click(); }

function queueItem(q) {
  const pct = q.size ? Math.round((q.loaded / q.size) * 100) : 0;
  const up = q.status === 'uploading';
  const meta = q.status === 'error' ? `<span style="color:var(--red)">${esc(q.error)}</span>`
    : q.status === 'done' ? `<span>${formatBytes(q.size)}</span><span>Ready to share</span>`
      : `<span>${formatBytes(q.loaded)} of ${formatBytes(q.size)}</span>${q.speed ? `<span>${formatBytes(q.speed)}/s</span><span>${countdown(((q.size - q.loaded) / q.speed) * 1000)} left</span>` : '<span>Starting…</span>'}`;
  return `<div class="q-item ${q.status}" data-uid="${q.uid}">${fileIcon(q.name)}
    <div style="min-width:0"><p class="n">${esc(q.name)}</p><div class="q-meta">${meta}</div><div class="bar"><span style="width:${q.status === 'error' ? 100 : pct}%"></span></div></div>
    <div style="display:flex;gap:6px;align-items:center">${q.status === 'done'
    ? `<button class="btn btn-sm" data-act="copy-queue" data-share="${esc(q.shareId)}">${icon('link')}Copy link</button><button class="btn btn-sm btn-ghost btn-icon" data-act="details" data-id="${esc(q.shareId)}" title="Details">${icon('qr')}</button>`
    : up ? `<span class="mono subtle">${pct}%</span><button class="btn btn-ghost btn-icon btn-sm" data-act="cancel-upload" data-uid="${q.uid}" title="Cancel">${icon('x')}</button>` : ''}</div></div>`;
}

function paintQueue(q) {
  const box = $('#queue');
  const card = $('#upload-card');
  if (card) card.classList.toggle('is-active', state.queue.some((x) => x.status === 'uploading'));
  if (!box) return;
  box.classList.toggle('hidden', !state.queue.length);
  const html = queueItem(q);
  const existing = box.querySelector(`[data-uid="${q.uid}"]`);
  if (existing) existing.outerHTML = html; else box.insertAdjacentHTML('afterbegin', html);
}

function startUploads(files) {
  if (!files.length) return;
  if (state.view !== 'overview') location.hash = '#/overview';
  const o = state.opts;
  const opts = {
    expiresInHours: o.expiresInHours,
    password: o.password || undefined,
    maxDownloads: o.maxDownloads ? Number(o.maxDownloads) : 0,
    message: o.message || undefined,
  };
  const items = files.map((file) => ({ uid: ++uid, file, name: file.name, size: file.size, loaded: 0, status: 'queued' }));
  state.queue.unshift(...items);
  state.queue = state.queue.slice(0, 20);
  setTimeout(() => items.forEach(paintQueue), 0);
  const pending = [...items];
  const worker = async () => { while (pending.length) await uploadOne(pending.shift(), opts); };
  Promise.all([worker(), worker(), worker()]).then(() => refresh(true));
}

async function uploadOne(q, opts) {
  const contentType = q.file.type || 'application/octet-stream';
  try {
    if (q.size === 0) throw new Error('Empty files cannot be shared');
    q.status = 'uploading';
    paintQueue(q);
    const { file, uploadUrl } = await api('/api/files', { method: 'POST', body: { name: q.name, size: q.size, contentType, ...opts } });
    q.shareId = file.id;
    const t0 = performance.now();
    let last = 0;
    q.request = putWithProgress(uploadUrl, q.file, contentType, (loaded) => {
      q.loaded = loaded;
      q.speed = loaded / Math.max(0.001, (performance.now() - t0) / 1000);
      if (performance.now() - last > 120) { last = performance.now(); paintQueue(q); }
    });
    await q.request;
    q.loaded = q.size;
    // The S3 event Lambda marks the file ready as well; this call makes the dashboard update instantly.
    await api(`/api/files/${file.id}/complete`, { method: 'POST' }).catch(() => {});
    q.status = 'done';
    toast(`${q.name} is ready to share`);
  } catch (err) {
    q.status = 'error';
    q.error = err.message;
    if (q.shareId) api(`/api/files/${q.shareId}`, { method: 'DELETE' }).catch(() => {});
  }
  paintQueue(q);
}

// ============================================================================ live countdowns
function tick() {
  const now = Date.now();
  $$('[data-exp]').forEach((el) => {
    const exp = Number(el.dataset.exp);
    const left = exp - now;
    if (el.dataset.fmt === 'text') { el.textContent = countdown(left); return; }
    const total = Math.max(1, exp - Number(el.dataset.created));
    el.querySelector('.t').textContent = countdown(left);
    el.querySelector('.bar span').style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
    el.classList.toggle('soon', left < 3 * HOUR);
  });
}
