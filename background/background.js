/**
 * background.js — Service Worker (Manifest V3).
 *
 * Responsabilidades:
 *   1. Guardar la configuración (servidores, ajustes, historial) en chrome.storage.local.
 *   2. Mantener una conexión WebSocket SOLO con los servidores MCP habilitados.
 *   3. Exponer a popup y content scripts una API de mensajes (ver `handleMessage`).
 */
import { McpConnection } from './ws_client.js';
import { log, getLogs, clearLogs, flushLogs } from './logger.js';
import {
  STORAGE_KEYS as KEYS, DEFAULT_SETTINGS, MAX_ACTIVE_SERVERS,
  CALL_TIMEOUT_MS, HISTORY_LIMIT, SUPPORTED_URL_PATTERNS, PERMISSIONS,
  DISCOVERY_URL, DISCOVERY_TIMEOUT_MS,
} from '../shared/constants.js';

/** @type {Map<string, McpConnection>} serverId → conexión */
const connections = new Map();

// Serializa las mutaciones de storage para evitar condiciones de carrera.
let lock = Promise.resolve();
const withLock = (fn) => {
  const run = lock.then(() => fn());
  lock = run.catch(() => {});
  return run;
};

// ───────────────────────── Estado y almacenamiento ─────────────────────────

async function loadState() {
  const data = await chrome.storage.local.get([KEYS.servers, KEYS.settings]);
  const stored = data[KEYS.settings] ?? {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  // Migración desde 1.0: «ejecutar sin preguntar» (autoExecute) pasa a ser el permiso «allow».
  if (!PERMISSIONS.includes(stored.defaultPermission)) settings.defaultPermission = stored.autoExecute ? 'allow' : 'ask';
  const servers = (data[KEYS.servers] ?? []).filter((s) => s.url).map((s) => ({ // sin dirección = marcador de la 1.1: se descarta
    ...s,
    permission: PERMISSIONS.includes(s.permission) ? s.permission : settings.defaultPermission,
  }));
  return { servers, settings };
}

/** Servidores que pueden conectarse y usarse: activos, con dirección y no bloqueados. */
const isUsable = (s) => s.enabled && s.url && s.permission !== 'deny';

const saveServers = (servers) => chrome.storage.local.set({ [KEYS.servers]: servers });

/** Identificador legible y único que usará la IA para nombrar cada servidor. */
function assignSlugs(servers) {
  const used = new Set();
  const slugs = new Map();
  // Los MCP ya configurados (con dirección) eligen primero: así el MCP por defecto sin configurar no les quita el nombre.
  for (const s of [...servers].sort((a, b) => Boolean(b.url) - Boolean(a.url))) {
    const base = s.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
    let slug = base;
    for (let n = 2; used.has(slug); n += 1) slug = `${base}_${n}`;
    used.add(slug);
    slugs.set(s.id, slug);
  }
  return slugs;
}

// ───────────────────────── Conexiones ─────────────────────────

let broadcastTimer = null;
function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({ url: SUPPORTED_URL_PATTERNS });
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'STATE_CHANGED' }).catch(() => {});
  }, 300);
}

/** Último estado registrado por servidor: evita llenar el registro con cada reintento de reconexión. */
const lastLogged = new Map();

function logConnection(conn, evt) {
  const name = conn.server.name;
  if (evt.kind === 'tools') {
    log('info', 'server.tools', { server: name, tools: conn.tools.length });
    return;
  }
  if (evt.next === 'connected') {
    lastLogged.set(conn.server.id, 'up');
    log('info', 'server.connected', { server: name, url: conn.server.url, info: conn.serverInfo?.name });
  } else if (evt.next === 'error' || evt.next === 'disconnected') {
    const key = `down:${conn.lastError ?? ''}`;
    if (lastLogged.get(conn.server.id) === key) return;
    lastLogged.set(conn.server.id, key);
    log(evt.prev === 'connected' ? 'warn' : 'error', 'server.down', { server: name, url: conn.server.url, error: conn.lastError });
  }
}

function onConnectionChange(evt, conn) {
  if (conn) logConnection(conn, evt);
  if (evt.next === 'connected' || evt.prev === 'connected') {
    loadState().then(({ settings }) => updateBadge(settings.bridgeEnabled)).catch(() => {});
  }
  if (evt.kind === 'tools' || evt.prev === 'connected' || evt.next === 'connected') scheduleBroadcast();
}

/** Alinea las conexiones abiertas con los servidores habilitados en storage. */
/** Icono: «OFF» con el bridge apagado; si no, nº de MCP conectados (vacío si ninguno). */
async function updateBadge(enabled) {
  const connected = [...connections.values()].filter((c) => c.status === 'connected').length;
  await chrome.action.setBadgeText({ text: enabled ? (connected ? String(connected) : '') : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#0f766e' : '#6b7280' });
}

/** Panel lateral: si el usuario lo prefiere, el icono abre el panel en vez del popup. */
let appliedPanelPref = null;
async function applyActionBehavior(preferSidePanel) {
  if (appliedPanelPref === preferSidePanel) return;
  appliedPanelPref = preferSidePanel;
  await chrome.action.setPopup?.({ popup: preferSidePanel ? '' : 'popup/popup.html' });
  await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: Boolean(preferSidePanel) });
}

async function reconcile() {
  const { servers, settings } = await loadState();
  updateBadge(settings.bridgeEnabled).catch(() => {});
  applyActionBehavior(Boolean(settings.preferSidePanel)).catch(() => {});
  // Con el bridge apagado no se mantiene ninguna conexión.
  const wanted = new Map((settings.bridgeEnabled ? servers : []).filter(isUsable).slice(0, MAX_ACTIVE_SERVERS).map((s) => [s.id, s]));

  for (const [id, conn] of connections) {
    const target = wanted.get(id);
    if (!target || target.url !== conn.server.url) {
      conn.close();
      connections.delete(id);
      lastLogged.delete(id);
      log('info', 'server.closed', { server: conn.server.name });
    }
  }
  for (const [id, server] of wanted) {
    const existing = connections.get(id);
    if (existing) {
      existing.server = server;
    } else {
      const conn = new McpConnection(server, (evt) => onConnectionChange(evt, conn));
      connections.set(id, conn);
      conn.connect();
    }
  }
}

// ───────────────────────── Consultas ─────────────────────────

async function getSnapshot() {
  const { servers, settings } = await loadState();
  const slugs = assignSlugs(servers);
  return {
    ok: true,
    settings,
    bridge: bridgeStatus,
    update: { ...update },
    max: MAX_ACTIVE_SERVERS,
    servers: servers.map((s) => {
      const conn = connections.get(s.id);
      return {
        ...s,
        slug: slugs.get(s.id),
        status: conn?.status ?? 'disconnected',
        error: conn?.lastError ?? null,
        toolCount: conn?.tools.length ?? 0,
        tools: (conn?.tools ?? []).map((t) => ({ name: t.name, description: String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 180) })),
        approxTokens: conn ? Math.ceil(JSON.stringify(conn.tools).length / 4) : 0,
      };
    }),
  };
}

/** Herramientas de los servidores ACTIVOS (esto es lo que se inyecta al chat). */
async function getActiveTools() {
  await reconcile();
  const { servers, settings } = await loadState();
  if (!settings.bridgeEnabled) return { ok: true, tools: [], disabled: true };
  const slugs = assignSlugs(servers);
  const active = servers.filter(isUsable); // los MCP bloqueados («No permitir») no se describen a la IA: ahorra tokens
  await Promise.all(active.map((s) => connections.get(s.id)?.whenReady(4000)));

  const tools = [];
  for (const s of active) {
    for (const t of connections.get(s.id)?.tools ?? []) {
      tools.push({
        server: slugs.get(s.id),
        serverLabel: s.name,
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      });
    }
  }
  return { ok: true, tools };
}

async function addHistory(entry) {
  return withLock(async () => {
    const data = await chrome.storage.local.get(KEYS.history);
    const history = [entry, ...(data[KEYS.history] ?? [])].slice(0, HISTORY_LIMIT);
    await chrome.storage.local.set({ [KEYS.history]: history });
  });
}

/** Llamadas a herramientas en curso: la extensión nunca se recarga en medio de una. */
let inFlight = 0;

async function callTool(msg) {
  inFlight += 1;
  try { return await callToolInner(msg); } finally { inFlight -= 1; }
}

async function callToolInner({ server, name, arguments: args }) {
  const { servers, settings } = await loadState();
  if (!settings.bridgeEnabled) return { ok: false, error: 'El bridge está desactivado.' };
  const slugs = assignSlugs(servers);
  const active = servers.filter((s) => s.enabled && s.url);
  const target = server
    ? active.find((s) => slugs.get(s.id) === server || s.name === server || s.id === server)
    : (active.length === 1 ? active[0] : null);

  const label = target ? slugs.get(target.id) : (server ?? '?');
  const entry = { ts: Date.now(), server: label, tool: name, args: JSON.stringify(args ?? {}).slice(0, 300) };
  const fail = async (error) => {
    log('error', 'tool.call', { server: label, tool: name, error });
    await addHistory({ ...entry, status: 'error', error });
    return { ok: false, error };
  };

  if (!target) return fail(`El servidor «${label}» no está activo.`);
  if (target.permission === 'deny') return fail(`El usuario no permite usar «${label}».`);
  const conn = connections.get(target.id);
  if (conn && conn.status !== 'connected') conn.connect(); // sin esperar al backoff: reconecta ya
  if (!conn || !(await conn.whenReady(10_000))) return fail(`El servidor «${label}» no está conectado.`);
  if (!conn.tools.some((t) => t.name === name)) return fail(`La herramienta «${name}» no existe en «${label}».`);

  const started = Date.now();
  try {
    const result = await conn.callTool(name, args, CALL_TIMEOUT_MS);
    const ms = Date.now() - started;
    log(result?.isError ? 'warn' : 'info', 'tool.call', { server: label, tool: name, status: result?.isError ? 'error' : 'ok', ms, args: entry.args });
    await addHistory({ ...entry, status: result?.isError ? 'error' : 'ok', ms });
    return { ok: true, result };
  } catch (err) {
    log('error', 'tool.call', { server: label, tool: name, error: err.message, ms: Date.now() - started });
    await addHistory({ ...entry, status: 'error', error: err.message, ms: Date.now() - started });
    return { ok: false, error: err.message };
  }
}

// ───────────────────────── Descubrimiento de MCP del PC ─────────────────────────

/**
 * Habla con el canal de control del puente local.
 * Sin `request`: devuelve la lista de MCP configurados. Con `request`: la envía y devuelve la respuesta.
 */
function bridgeControl(request = null, { url = DISCOVERY_URL, timeout = DISCOVERY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    let listing = null;
    const timer = setTimeout(() => { try { ws?.close(); } catch { /* noop */ } reject(new Error('El puente no respondió. ¿Está en marcha?')); }, request ? timeout + 10_000 : timeout);
    const done = (fn, value) => { clearTimeout(timer); try { ws.close(); } catch { /* noop */ } fn(value); };
    try { ws = new WebSocket(url); } catch (err) { clearTimeout(timer); reject(err); return; }
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { done(reject, new Error('Respuesta inesperada del puente.')); return; }
      if (!listing) {
        if (msg?.type !== 'servers' || !Array.isArray(msg.servers)) { done(reject, new Error('Respuesta inesperada del puente.')); return; }
        listing = msg;
        if (!request) done(resolve, msg);
        else ws.send(JSON.stringify(request));
        return;
      }
      if (msg?.ok === false) done(reject, new Error(msg.error || 'El puente rechazó la petición.'));
      else done(resolve, msg);
    };
    ws.onerror = () => done(reject, new Error(`No se pudo contactar con el puente local (${url}).`));
  });
}

/** Último estado conocido del puente local (lo muestra la interfaz). */
const bridgeStatus = { ok: null, at: 0, count: 0, error: null, configError: null };

async function fetchDiscovery() {
  try {
    const listing = await bridgeControl();
    Object.assign(bridgeStatus, { ok: true, at: Date.now(), count: listing.servers.length, error: null, configError: listing.config_error ?? null });
    return listing;
  } catch (err) {
    Object.assign(bridgeStatus, { ok: false, at: Date.now(), error: err.message });
    throw err;
  }
}

/** Puerto de una dirección ws:// local, o null si no es local. */
function localPort(raw) {
  try {
    const url = new URL(raw);
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? Number(url.port || 80) : null;
  } catch { return null; }
}

// ───────────────────────── Mutaciones (desde el popup) ─────────────────────────

function validateUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('La dirección no es válida.'); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('La dirección debe empezar por ws:// o wss://');
  return url.toString().replace(/\/$/, '');
}

/** Ajustes y cambios de configuración que se registran (sin datos sensibles). */
function describeMutation(msg) {
  const { type, ...rest } = msg;
  if (type === 'UPDATE_SETTINGS') return { settings: rest.settings };
  if (type === 'PUT_BRIDGE_CONFIG') return { bytes: String(rest.content ?? '').length }; // el contenido no se copia al registro
  return rest;
}

const mutate = (fn) => withLock(async () => {
  const { servers, settings } = await loadState();
  const result = await fn(servers, settings);
  await reconcile();
  scheduleBroadcast();
  return result ?? { ok: true };
});

/** Nombres de los MCP quitados (para el registro, que se escribe después de borrarlos). */
const removedNames = new Map();

const mutations = {
  ADD_SERVER: ({ name, url }) => mutate(async (servers, settings) => {
    const cleanUrl = validateUrl(String(url ?? '').trim());
    const cleanName = String(name ?? '').trim() || 'mcp';
    if (servers.some((s) => s.url === cleanUrl)) throw new Error('Esa dirección ya está registrada.');
    // Por defecto solo hay 1 MCP activo: el primero que se registra.
    servers.push({
      id: crypto.randomUUID(), name: cleanName, url: cleanUrl, enabled: servers.every((s) => !s.enabled), permission: settings.defaultPermission,
    });
    await saveServers(servers);
  }),

  /** Permiso de UN MCP: allow (siempre) · ask (preguntar) · deny (no permitir). */
  SET_PERMISSION: ({ id, permission }) => mutate(async (servers) => {
    if (!PERMISSIONS.includes(permission)) throw new Error('Permiso no válido.');
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Servidor no encontrado.');
    server.permission = permission;
    await saveServers(servers);
  }),

  /** Mismo selector para TODOS los MCP (y para los que se añadan después). */
  SET_ALL_PERMISSIONS: ({ permission }) => mutate(async (servers, settings) => {
    if (!PERMISSIONS.includes(permission)) throw new Error('Permiso no válido.');
    servers.forEach((s) => { s.permission = permission; });
    await saveServers(servers);
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, defaultPermission: permission } });
  }),

  REMOVE_SERVER: ({ id }) => mutate(async (servers) => {
    const gone = servers.find((s) => s.id === id);
    if (gone) removedNames.set(id, gone.name);
    await saveServers(servers.filter((s) => s.id !== id));
  }),

  RENAME_SERVER: ({ id, name }) => mutate(async (servers) => {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Servidor no encontrado.');
    server.name = String(name ?? '').trim() || server.name;
    await saveServers(servers);
  }),

  TOGGLE_SERVER: ({ id, enabled }) => mutate(async (servers) => {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Servidor no encontrado.');
    if (enabled && servers.filter((s) => s.enabled && s.id !== id).length >= MAX_ACTIVE_SERVERS) {
      throw new Error(`Solo puedes tener ${MAX_ACTIVE_SERVERS} servidores MCP activos a la vez.`);
    }
    server.enabled = Boolean(enabled);
    await saveServers(servers);
  }),

  /**
   * Registra los MCP que el puente tiene configurados y aún no están en la lista.
   * Se añaden DESACTIVADOS: el usuario elige cuáles activar con su interruptor.
   */
  DISCOVER_SERVERS: () => mutate(async (servers, settings) => {
    const listing = await fetchDiscovery();
    const found = listing.servers;
    const known = new Set(servers.map((s) => localPort(s.url)).filter(Boolean));
    const added = [];
    for (const item of found) {
      const port = Number(item?.port);
      if (!Number.isInteger(port) || port <= 0 || known.has(port)) continue;
      const name = String(item.name ?? '').trim().slice(0, 40) || `mcp-${port}`;
      servers.push({ id: crypto.randomUUID(), name, url: `ws://localhost:${port}`, enabled: false, permission: settings.defaultPermission });
      known.add(port);
      added.push(name);
    }
    if (added.length) await saveServers(servers);
    return { ok: true, found: found.length, added, configError: listing.config_error ?? null };
  }),

  UPDATE_SETTINGS: ({ settings: patch }) => mutate(async (_servers, settings) => {
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, ...patch } });
  }),
};

// ───────────────────────── Router de mensajes ─────────────────────────

/** Temporizador que NO depende de la pestaña: las pestañas ocultas frenan sus setTimeout, el service worker no. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30_000)));

async function focusTab(sender) {
  const tab = sender?.tab;
  if (!tab?.id) return { ok: false, error: 'Sin pestaña.' };
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const prev = previous && previous.id !== tab.id ? { tabId: previous.id, windowId: previous.windowId } : null;
  return { ok: true, prev };
}

async function restoreFocus({ prev }) {
  if (!prev) return { ok: true };
  await chrome.tabs.update(prev.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(prev.windowId, { focused: true }).catch(() => {});
  return { ok: true };
}

async function handleMessage(msg, sender) {
  if (mutations[msg.type]) return mutations[msg.type](msg);
  switch (msg.type) {
    case 'SLEEP': await sleep(msg.ms); return { ok: true };
    case 'FOCUS_TAB': return focusTab(sender);
    case 'RESTORE_FOCUS': return restoreFocus(msg);
    case 'GET_STATE': return getSnapshot();
    case 'GET_ACTIVE_TOOLS': return getActiveTools();
    case 'CALL_TOOL': return callTool(msg);
    case 'GET_HISTORY': {
      const data = await chrome.storage.local.get(KEYS.history);
      return { ok: true, history: data[KEYS.history] ?? [] };
    }
    case 'LOG': // eventos de los content scripts y del popup
      log(msg.level, msg.event, msg.details, { source: sourceOf(sender), platform: msg.platform });
      return { ok: true };
    case 'GET_LOGS': return { ok: true, logs: await getLogs() };
    case 'GET_BRIDGE_CONFIG': {
      const res = await bridgeControl({ type: 'get_config' });
      return { ok: true, content: res.content, path: res.path };
    }
    case 'PUT_BRIDGE_CONFIG': {
      const res = await bridgeControl({ type: 'put_config', content: String(msg.content ?? '') });
      log('info', 'bridge.config_saved', { servers: res.servers?.map((s) => `${s.name}:${s.port}`) });
      return { ok: true, servers: res.servers };
    }
    case 'CHECK_UPDATE': return { ok: true, update: await checkUpdate() };
    case 'OPEN_EDITOR':
      await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
      return { ok: true };
    case 'CLEAR_LOGS':
      await clearLogs();
      log('info', 'logs.cleared');
      return { ok: true };
    case 'CLEAR_HISTORY':
      await chrome.storage.local.remove(KEYS.history);
      return { ok: true };
    case 'RECONNECT':
      connections.get(msg.id)?.close();
      connections.delete(msg.id);
      await reconcile();
      return { ok: true };
    default:
      return { ok: false, error: `Mensaje desconocido: ${msg.type}` };
  }
}

/** Origen de un mensaje: el popup (o el panel lateral) también puede abrirse en una pestaña con URL chrome-extension://. */
const sourceOf = (sender) => (sender?.tab && !String(sender.url ?? '').startsWith('chrome-extension://') ? 'content' : 'popup');

/** Mensajes que NO se registran (frecuentes o de solo lectura). */
const QUIET = new Set(['CHECK_UPDATE', 'SLEEP', 'GET_STATE', 'GET_ACTIVE_TOOLS', 'GET_HISTORY', 'GET_LOGS', 'CLEAR_LOGS', 'LOG', 'CALL_TOOL', 'GET_BRIDGE_CONFIG', 'OPEN_EDITOR', 'FOCUS_TAB', 'RESTORE_FOCUS']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((res) => {
      if (!QUIET.has(msg?.type)) {
        const level = res?.ok === false ? 'warn' : 'info';
        const details = { ...describeMutation(msg), ...(res?.ok === false ? { error: res.error } : {}) };
        const write = () => log(level, `action.${String(msg?.type).toLowerCase()}`, details, { source: sourceOf(sender) });
        if (msg?.id) { // nombre legible del MCP en vez de solo su ID
          (msg.type === 'REMOVE_SERVER' ? Promise.resolve(removedNames.get(msg.id)) : loadState().then(({ servers }) => servers.find((s) => s.id === msg.id)?.name))
            .then((name) => { if (name) details.server = name; }).catch(() => {}).finally(write);
        } else write();
      }
      sendResponse(res);
    })
    .catch((err) => {
      log('error', `action.${String(msg?.type).toLowerCase()}`, { ...describeMutation(msg ?? {}), error: err?.message ?? String(err) }, { source: sourceOf(sender) });
      sendResponse({ ok: false, error: err?.message ?? String(err) });
    });
  return true; // respuesta asíncrona
});

// ───────────────────────── Ciclo de vida ─────────────────────────

// La extensión se instala SIN ningún MCP: cada usuario añade los suyos (astrax_mcp u otros) desde el popup.
chrome.runtime.onInstalled.addListener(async () => {
  const { servers } = await loadState();                 // ya descarta los marcadores sin dirección de la 1.1
  await saveServers(servers);
  await reconcile();
});

// ───────────────────────── Actualización automática ─────────────────────────
// La tarea programada (scripts/windows/update.ps1) baja la versión nueva de main y escribe update-stamp.json.
// La extensión, cargada desde esa carpeta, lee el sello: si el commit cambió desde que arrancó, se recarga sola.

const update = { bootCommit: null, commit: null, branch: null, status: null, checkedAt: null, pendingReload: false };

async function readStamp() {
  try {
    const res = await fetch(chrome.runtime.getURL('update-stamp.json'), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch { return null; } // sin sello: la actualización automática no está instalada
}

/**
 * Commit con el que se CARGÓ la extensión. Se guarda en storage.session: sobrevive a que Chrome duerma y despierte el
 * service worker (si no, una versión llegada mientras dormía se tomaría como «la de arranque» y nunca se recargaría),
 * y se borra al recargar la extensión o reiniciar el navegador.
 */
async function bootCommit(current) {
  const area = chrome.storage.session;
  if (!area) return current;
  const saved = (await area.get('wmb_boot_commit')).wmb_boot_commit;
  if (saved) return saved;
  if (current) await area.set({ wmb_boot_commit: current });
  return current;
}

async function checkUpdate() {
  const stamp = await readStamp();
  if (stamp) {
    Object.assign(update, { commit: stamp.commit ?? null, branch: stamp.branch ?? null, status: stamp.status ?? null, checkedAt: stamp.checkedAt ?? null });
    if (!update.bootCommit) update.bootCommit = await bootCommit(stamp.commit ?? null);
  }
  const { settings } = await loadState();
  const changed = Boolean(update.bootCommit && update.commit && update.commit !== update.bootCommit);
  update.pendingReload = changed;
  if (changed && settings.autoUpdate !== false && inFlight === 0) {
    log('info', 'update.reload', { from: update.bootCommit.slice(0, 7), to: update.commit.slice(0, 7) });
    await flushLogs();
    setTimeout(() => chrome.runtime.reload(), 300);
  }
  return { ...update };
}

// Red de seguridad: si el SW se duerme, la alarma lo despierta y reconecta. Cada minuto, además, se mira si hay versión nueva.
chrome.alarms.create('wmb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.create('wmb-update', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wmb-keepalive') reconcile().catch((err) => log('error', 'reconcile', { error: err.message }));
  if (alarm.name === 'wmb-update') checkUpdate().catch(() => {});
});
checkUpdate().catch(() => {});

log('info', 'sw.start', { version: chrome.runtime.getManifest?.().version });
reconcile().catch((err) => { console.error('[WMB] reconcile', err); log('error', 'reconcile', { error: err.message }); });
