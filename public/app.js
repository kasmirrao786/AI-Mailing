// ---------- core helpers ----------
async function api(path, opts) {
  const res = await fetch(path, {
    method: (opts && opts.method) || 'GET',
    headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) { window.location.href = '/login.html'; throw new Error('Not authenticated'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function apiUpload(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData });
  if (res.status === 401) { window.location.href = '/login.html'; throw new Error('Not authenticated'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, isError) {
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function badge(text, kind) {
  return `<span class="badge${kind ? ' ' + kind : ''}">${esc(text)}</span>`;
}

const STATUS_BADGE_KIND = {
  sent: 'signal', completed: 'signal', active: 'signal', booking: 'signal',
  draft: '', queued: 'amber', running: 'amber', pending: 'amber',
  failed: 'alert', bounced: 'alert', error: 'alert', stopped: 'alert', cancelled: 'alert', replied: 'signal'
};
function statusBadge(status) {
  return badge(status, STATUS_BADGE_KIND[status] || '');
}

function openModal(html) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal">${html}</div></div>`;
  document.getElementById('modalBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modalBackdrop') closeModal();
  });
}
function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
}

// ---------- nav / routing ----------
const ROUTES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'clientTypes', label: 'Client types' },
  { id: 'assets', label: 'Assets' },
  { id: 'sequences', label: 'Sequences' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'sendJobs', label: 'Send jobs' },
  { id: 'mailboxes', label: 'Mailboxes' },
  { id: 'settings', label: 'Settings' }
];

let currentRoute = 'dashboard';

function renderNav() {
  const navGroup = document.getElementById('navGroup');
  navGroup.innerHTML = ROUTES.map(r =>
    `<div class="nav-item${r.id === currentRoute ? ' active' : ''}" data-route="${r.id}"><span class="nav-dot"></span>${esc(r.label)}</div>`
  ).join('');
  navGroup.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.route));
  });
}

async function navigate(routeId) {
  currentRoute = routeId;
  window.location.hash = routeId;
  renderNav();
  const route = ROUTES.find(r => r.id === routeId);
  document.getElementById('pageTitle').textContent = route ? route.label : '';
  document.getElementById('topbarActions').innerHTML = '';
  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await VIEWS[routeId]();
  } catch (e) {
    content.innerHTML = `<div class="error-banner">${esc(e.message)}</div>`;
  }
}

window.addEventListener('hashchange', () => {
  const routeId = window.location.hash.replace('#', '') || 'dashboard';
  if (ROUTES.find(r => r.id === routeId)) navigate(routeId);
});

document.addEventListener('DOMContentLoaded', () => {
  renderNav();
  const routeId = window.location.hash.replace('#', '') || 'dashboard';
  navigate(ROUTES.find(r => r.id === routeId) ? routeId : 'dashboard');
});

// VIEWS is populated by the other app-*.js files, loaded after this one.
const VIEWS = {};
