/**
 * popup.js — Interfaz de la extensión. La MISMA página funciona como ventana emergente y como panel lateral.
 *
 * Pestañas:
 *   - MCP:       estado del puente local, detectar / editar MCP, activar (máx. 5), permisos y herramientas de cada MCP.
 *   - Actividad: llamadas a herramientas y registro de eventos (filtrar, exportar, borrar).
 *   - Ajustes:   interfaz (panel lateral) y comportamiento en el chat.
 */
import { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, PERMISSION_LABELS, DEMO_SERVER } from '../shared/constants.js';

const $ = (selector, root = document) => root.querySelector(selector);
const STATUS_TEXT = {
  connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Sin conexión, reintentando', error: 'Error de conexión',
};

// ───────────────────────── Contexto: popup o panel lateral ─────────────────────────

const isPopup = (chrome.extension?.getViews?.({ type: 'popup' }) ?? []).includes(window);
document.documentElement.dataset.view = isPopup ? 'popup' : 'panel';
let windowId = null;
chrome.windows?.getCurrent?.().then((w) => { windowId = w.id; }).catch(() => {});

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* sin almacenamiento */ } },
};

// ───────────────────────── Utilidades ─────────────────────────

async function api(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'Error desconocido.');
  return res;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3400);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message); }
  await refresh(true);
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function iconButton(name, title, onClick, extra = '') {
  return el('button', { type: 'button', class: `icon-btn ${extra}`.trim(), title, 'aria-label': title, onclick: onClick }, icon(name));
}

const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return new Date(ts).toLocaleTimeString('es');
};

// ───────────────────────── Puente local ─────────────────────────

function renderBridge(bridge) {
  const dot = $('#bridge-dot');
  const title = $('#bridge-title');
  const detail = $('#bridge-detail');
  if (!bridge || bridge.ok === null) {
    dot.className = 'dot connecting';
    title.textContent = 'Comprobando el puente local…';
    detail.textContent = '';
  } else if (bridge.ok) {
    dot.className = 'dot ok';
    title.textContent = 'Puente local activo';
    detail.textContent = `${bridge.count} MCP configurado${bridge.count === 1 ? '' : 's'} en tu PC · ${ago(bridge.at)}`;
  } else {
    dot.className = 'dot down';
    title.textContent = 'El puente local no responde';
    detail.textContent = 'Arráncalo con scripts\\windows\\install.ps1 (después inicia solo con Windows).';
  }
  const banner = $('#config-error');
  banner.hidden = !bridge?.configError;
  banner.textContent = bridge?.configError
    ? `La configuración de MCP tiene un error y no se aplicó: ${bridge.configError}. Corrígela en «Añadir o editar MCP».`
    : '';
}

/** Pide al puente los MCP del PC y registra los nuevos (desactivados). `quiet`: sin avisos si no hay nada nuevo. */
async function discover(quiet = false) {
  const button = $('#discover');
  button.disabled = true;
  try {
    const { found, added } = await api('DISCOVER_SERVERS');
    if (added.length) toast(`Nuevos MCP: ${added.join(', ')}. Actívalos con su interruptor.`);
    else if (!quiet) toast(found ? `Sin MCP nuevos (${found} configurados).` : 'El puente no tiene MCP configurados.');
  } catch (err) {
    if (!quiet) toast(err.message);
  } finally {
    button.disabled = false;
  }
  await refresh(true);
}

// ───────────────────────── Lista de MCP ─────────────────────────

const openTools = new Set(); // MCP con la lista de herramientas desplegada (sobrevive a los refrescos)

function permSelect(value, onChange, label) {
  const select = el('select', { class: 'perm', 'aria-label': label });
  select.dataset.perm = value;
  for (const perm of PERMISSIONS) select.append(new Option(PERMISSION_LABELS[perm], perm, false, perm === value));
  select.addEventListener('change', guard(() => onChange(select.value)));
  return select;
}

function startRename(label, server) {
  const input = el('input', { type: 'text', maxlength: '40', 'aria-label': `Nuevo nombre de ${server.name}` });
  input.value = server.name;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = guard(async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== server.name) await api('RENAME_SERVER', { id: server.id, name: value });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function renderServer(server, activeCount) {
  const blocked = server.permission === 'deny';
  const li = el('li', { class: `server${server.enabled ? ' on' : ''}` });

  const checkbox = el('input', { type: 'checkbox', 'aria-label': `Activar ${server.name}` });
  checkbox.checked = server.enabled;
  checkbox.disabled = !server.enabled && activeCount >= MAX_ACTIVE_SERVERS;
  checkbox.addEventListener('change', guard(() => api('TOGGLE_SERVER', { id: server.id, enabled: checkbox.checked })));
  const toggle = el('label', { class: 'switch', title: server.enabled ? 'Desactivar' : (checkbox.disabled ? `Máximo ${MAX_ACTIVE_SERVERS} activos` : 'Activar') }, checkbox, el('span'));

  const label = el('span', { text: server.name });
  const name = el('div', { class: 'name' }, el('i', { class: `dot ${server.enabled ? server.status : ''}` }), label);
  let metaText = server.url;
  if (blocked) metaText += ' · Bloqueado: la IA no lo ve';
  else if (server.enabled) metaText += ` · ${STATUS_TEXT[server.status] ?? server.status}`;
  const info = el('div', { class: 'grow' }, name, el('div', { class: 'meta', text: metaText }));
  if (server.enabled && server.error && server.status !== 'connected') info.append(el('div', { class: 'error-detail', text: server.error }));

  const actions = el('div', { class: 'actions' },
    iconButton('edit', 'Renombrar', () => startRename(label, server)),
    iconButton('trash', 'Quitar de la extensión', guard(async () => {
      if (confirm(`¿Quitar «${server.name}» de la extensión? (No se borra de la configuración del PC; «Detectar» lo volvería a añadir).`)) {
        await api('REMOVE_SERVER', { id: server.id });
      }
    }), 'danger'),
  );
  li.append(el('div', { class: 'server-main' }, toggle, info, actions));

  const foot = el('div', { class: 'server-foot' });
  const tools = server.tools ?? [];
  if (tools.length) {
    const expanded = openTools.has(server.id);
    const btn = el('button', { type: 'button', class: 'tools-toggle', 'aria-expanded': String(expanded) },
      icon('chevron', 'icon chev'), `${tools.length} herramientas`);
    btn.addEventListener('click', () => {
      if (openTools.has(server.id)) openTools.delete(server.id); else openTools.add(server.id);
      refresh(true);
    });
    foot.append(btn);
  } else foot.append(el('span'));
  foot.append(permSelect(server.permission, (value) => api('SET_PERMISSION', { id: server.id, permission: value }), `Permiso de ${server.name}`));
  li.append(foot);

  if (tools.length && openTools.has(server.id)) {
    li.append(el('ul', { class: 'tools' }, ...tools.map((t) => el('li', {}, el('b', { text: t.name }), t.description ? el('span', { text: t.description }) : null))));
  }
  return li;
}

function renderServers(state) {
  const active = state.servers.filter((s) => s.enabled);
  $('#counter').textContent = `${active.length} de ${MAX_ACTIVE_SERVERS} activos`;
  const tokens = active.reduce((sum, s) => sum + s.approxTokens, 0);
  $('#tokens').textContent = active.length ? `· ≈ ${tokens.toLocaleString('es')} tokens` : '';
  $('#summary').hidden = state.servers.length === 0;

  const warning = $('#warning');
  warning.hidden = active.length <= RECOMMENDED_ACTIVE_SERVERS;
  warning.textContent = `Tienes ${active.length} MCP activos: cada herramienta ocupa contexto de la IA. Activa solo los que necesites para esta tarea.`;
  $('#empty').hidden = state.servers.length > 0;

  $('#server-list').replaceChildren(...state.servers.map((s) => renderServer(s, active.length)));
}

function renderGlobalPermission(servers) {
  const select = $('#perm-all');
  const perms = new Set(servers.map((s) => s.permission));
  const value = perms.size === 1 ? [...perms][0] : (perms.size === 0 ? 'ask' : 'mixed');
  select.value = value;
  select.dataset.perm = value;
}

// ───────────────────────── Actividad ─────────────────────────

let activityView = store.get('wmb-activity-view', 'calls');

function setActivityView(view) {
  activityView = view;
  store.set('wmb-activity-view', view);
  for (const b of document.querySelectorAll('.segmented button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  $('#view-calls').hidden = view !== 'calls';
  $('#view-logs').hidden = view !== 'logs';
  refresh(true);
}

async function renderHistory() {
  const { history } = await api('GET_HISTORY');
  $('#history-empty').hidden = history.length > 0;
  $('#history-list').replaceChildren(...history.map((h) => el('li', {},
    el('div', { class: 'row' },
      el('span', { text: `${h.server} › ${h.tool}` }),
      el('span', { class: h.status === 'ok' ? 'ok' : 'error', text: h.status === 'ok' ? `OK${h.ms ? ` · ${h.ms} ms` : ''}` : 'Error' })),
    el('small', { text: `${new Date(h.ts).toLocaleTimeString('es')} · ${h.error ?? h.args}` }),
  )));
}

const LOG_SHOWN = 150;
const LEVEL_RANK = { info: 0, warn: 1, error: 2 };
const LEVEL_TEXT = { info: 'Info', warn: 'Aviso', error: 'Error' };

async function renderLogs() {
  const { logs } = await api('GET_LOGS');
  const min = { all: 0, warn: 1, error: 2 }[$('#log-level').value] ?? 0;
  const shown = logs.filter((l) => (LEVEL_RANK[l.level] ?? 0) >= min).slice(-LOG_SHOWN).reverse();
  $('#log-empty').hidden = shown.length > 0;
  $('#log-count').textContent = logs.length ? `${logs.length} eventos guardados · se muestran ${shown.length}` : '';
  $('#log-list').replaceChildren(...shown.map((l) => el('li', {},
    el('div', { class: 'row' },
      el('span', { text: `${l.event}${l.platform ? ` · ${l.platform}` : ''}` }),
      el('span', { class: l.level === 'info' ? 'ok' : l.level, text: LEVEL_TEXT[l.level] ?? l.level })),
    el('small', { text: `${new Date(l.ts).toLocaleTimeString('es')} · ${l.source}${l.details ? ` · ${JSON.stringify(l.details)}` : ''}` }),
  )));
}

// ───────────────────────── Ajustes ─────────────────────────

function renderSettings(settings) {
  $('#master').checked = settings.bridgeEnabled;
  $('#master-label').textContent = settings.bridgeEnabled ? 'Bridge activado' : 'Bridge desactivado: no se conecta ni se inyecta nada';
  $('#main').classList.toggle('off', !settings.bridgeEnabled);
  for (const key of ['autoInject', 'autoSend', 'reminder', 'focusFallback', 'preferSidePanel']) $(`#set-${key}`).checked = Boolean(settings[key]);
  if (document.activeElement?.id !== 'set-maxResultChars') $('#set-maxResultChars').value = settings.maxResultChars;
  if (document.activeElement?.id !== 'set-reinjectEvery') $('#set-reinjectEvery').value = settings.reinjectEvery;
}

// ───────────────────────── Pestañas y refresco ─────────────────────────

let currentTab = store.get('wmb-tab', 'mcp');

function setTab(tab) {
  currentTab = ['mcp', 'activity', 'settings'].includes(tab) ? tab : 'mcp';
  store.set('wmb-tab', currentTab);
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === currentTab));
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== `tab-${currentTab}`;
  refresh(true);
}

let selectFocusedAt = 0;
document.addEventListener('focusin', (e) => { if (e.target.matches?.('select')) selectFocusedAt = Date.now(); });

async function refresh(force = false) {
  if (!force && document.activeElement?.matches('input[type="text"], input[type="number"]')) return; // escribiendo
  if (!force && document.activeElement?.matches('select') && Date.now() - selectFocusedAt < 6000) return;
  try {
    const state = await api('GET_STATE');
    renderBridge(state.bridge);
    renderServers(state);
    renderGlobalPermission(state.servers);
    renderSettings(state.settings);
    if (currentTab === 'activity') {
      if (activityView === 'calls') await renderHistory();
      else await renderLogs();
    }
  } catch (err) { toast(err.message); }
}

// ───────────────────────── Eventos ─────────────────────────

for (const btn of document.querySelectorAll('.tabs button')) btn.addEventListener('click', () => setTab(btn.dataset.tab));
document.querySelector('.tabs').addEventListener('keydown', (e) => { // flechas entre pestañas
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('.tabs button')];
  const i = tabs.findIndex((t) => t.dataset.tab === currentTab);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  setTab(next.dataset.tab);
});
for (const btn of document.querySelectorAll('.segmented button')) btn.addEventListener('click', () => setActivityView(btn.dataset.view));

$('#open-panel').addEventListener('click', async () => {
  try {
    if (windowId == null) throw new Error('No se encontró la ventana.');
    await chrome.sidePanel.open({ windowId });
    window.close();
  } catch (err) { toast(`No se pudo abrir el panel lateral: ${err.message}`); }
});
$('#discover').addEventListener('click', () => discover(false));
$('#open-editor').addEventListener('click', guard(async () => { await api('OPEN_EDITOR'); if (isPopup) window.close(); }));
$('#add-demo').addEventListener('click', guard(() => api('ADD_SERVER', DEMO_SERVER)));
$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('ADD_SERVER', { name: $('#add-name').value, url: $('#add-url').value });
    event.target.reset();
    toast('MCP añadido.');
  } catch (err) { toast(err.message); }
  await refresh(true);
});
$('#perm-all').addEventListener('change', guard((e) => api('SET_ALL_PERMISSIONS', { permission: e.target.value })));
$('#master').addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { bridgeEnabled: e.target.checked } })));
for (const key of ['autoInject', 'autoSend', 'reminder', 'focusFallback', 'preferSidePanel']) {
  $(`#set-${key}`).addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { [key]: e.target.checked } })));
}
$('#set-reinjectEvery').addEventListener('change', guard((e) => {
  const value = Math.min(100, Math.max(0, Math.round(Number(e.target.value)) || 0));
  return api('UPDATE_SETTINGS', { settings: { reinjectEvery: value } });
}));
$('#set-maxResultChars').addEventListener('change', guard((e) => {
  const value = Math.min(100000, Math.max(500, Number(e.target.value) || 12000));
  return api('UPDATE_SETTINGS', { settings: { maxResultChars: value } });
}));
$('#clear-history').addEventListener('click', guard(async () => { await api('CLEAR_HISTORY'); }));
$('#log-level').addEventListener('change', () => renderLogs().catch((err) => toast(err.message)));
$('#clear-logs').addEventListener('click', guard(async () => {
  if (confirm('¿Borrar todo el registro de eventos?')) await api('CLEAR_LOGS');
}));
$('#export-logs').addEventListener('click', guard(async () => {
  const { logs } = await api('GET_LOGS');
  const payload = { exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent, logs };
  const a = el('a', { download: `web-mcp-bridge-registro-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json` });
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exportados ${logs.length} eventos.`);
}));

// ───────────────────────── Inicio ─────────────────────────

setTab(currentTab);
setActivityView(activityView);
discover(true);
setInterval(refresh, 1500);
if (!isPopup) setInterval(() => discover(true), 20_000); // el panel queda abierto: el estado del puente se mantiene al día
