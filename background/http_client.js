/**
 * http_client.js — Cliente MCP por «Streamable HTTP» (sin puente ni mcp-proxy).
 *
 * Misma interfaz que `McpConnection` (ws_client.js): status, tools, serverInfo, lastError, connect(), close(),
 * whenReady(), request(), callTool(). Así background.js usa uno u otro según la dirección (http:// o ws://).
 *
 * Protocolo (MCP 2025-03-26):
 *   - Cada mensaje JSON-RPC es un POST a la URL del MCP con `Accept: application/json, text/event-stream`.
 *   - La respuesta llega como JSON o como un flujo SSE (`data: {...}`) que contiene la respuesta con el mismo id.
 *   - `initialize` devuelve la cabecera `Mcp-Session-Id`, que se envía en todas las peticiones siguientes.
 *   - Al cerrar se envía DELETE con esa sesión (cortesía con el servidor).
 *
 * Nota: los servidores FastMCP en 127.0.0.1 rechazan (403) el `Origin: chrome-extension://…`. background.js instala
 * una regla declarativeNetRequest que quita esa cabecera SOLO en las peticiones de esta extensión a localhost.
 */
import { PROTOCOL_VERSION } from '../shared/constants.js';

const KEEPALIVE_MS = 25_000;
const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/** Lee un cuerpo SSE y devuelve los mensajes JSON de sus eventos `data:`. */
export function parseSse(text) {
  const messages = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch { /* evento no JSON: se ignora */ }
  }
  return messages;
}

export class HttpMcpConnection {
  #session = null;
  #nextId = 1;
  #closedByUser = false;
  #attempt = 0;
  #reconnectTimer = null;
  #keepaliveTimer = null;
  #connecting = null;
  #controllers = new Set();
  #ready = null;
  #resolveReady = null;

  constructor(server, onChange = () => {}, gate = () => null) {
    this.server = server;
    this.onChange = onChange;
    this.gate = gate;
    this.status = 'disconnected';
    this.tools = [];
    this.serverInfo = null;
    this.lastError = null;
    this.#resetReady();
  }

  // ───────────────────────── API pública ─────────────────────────

  connect() {
    this.#closedByUser = false;
    clearTimeout(this.#reconnectTimer);
    if (this.#connecting || this.status === 'connected') return;
    const blocked = this.gate();
    if (blocked) {
      this.lastError = blocked;
      this.#setStatus('error');
      this.#scheduleReconnect();
      return;
    }
    this.#setStatus('connecting');
    this.#connecting = this.#handshake()
      .catch((err) => {
        if (this.#closedByUser) return;
        this.lastError = err.message;
        this.#session = null;
        this.#setStatus('error');
        this.#scheduleReconnect();
      })
      .finally(() => { this.#connecting = null; });
  }

  close() {
    this.#closedByUser = true;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#keepaliveTimer);
    for (const c of this.#controllers) c.abort();
    this.#controllers.clear();
    if (this.#session) {
      fetch(this.server.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.#session } }).catch(() => {});
      this.#session = null;
    }
    this.tools = [];
    if (this.status === 'connected') this.#resetReady();
    this.#setStatus('disconnected');
  }

  whenReady(timeoutMs = 4000) {
    if (this.status === 'connected') return Promise.resolve(true);
    return Promise.race([
      this.#ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  /** Envía una petición JSON-RPC y devuelve su `result` (o lanza con el error del servidor). */
  async request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.#nextId++;
    const reply = await this.#post({ jsonrpc: '2.0', id, method, params }, timeoutMs, method);
    const msg = reply.find((m) => m?.id === id) ?? null;
    if (!msg) throw new Error(`El MCP no respondió a «${method}».`);
    if (msg.error) throw new Error(msg.error.message ?? 'Error MCP');
    return msg.result;
  }

  async notify(method, params) {
    await this.#post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, REQUEST_TIMEOUT_MS, method).catch(() => {});
  }

  callTool(name, args, timeoutMs) {
    return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs);
  }

  async refreshTools() {
    const tools = [];
    let cursor;
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(res.tools ?? []));
      cursor = res.nextCursor;
    } while (cursor);
    this.tools = tools;
    this.onChange({ kind: 'tools' });
  }

  // ───────────────────────── Internos ─────────────────────────

  async #post(body, timeoutMs, label) {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    if (this.serverInfo) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
    let res;
    try {
      res = await fetch(this.server.url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
      const session = res.headers.get('mcp-session-id');
      if (session) this.#session = session;
      if (res.status === 202 || res.status === 204) return [];
      if (res.status === 404 && this.#session && body.method !== 'initialize') {
        // El servidor olvidó la sesión (se reinició): se reconecta.
        this.#session = null;
        this.#lost('El MCP se reinició: reconectando…');
        throw new Error('Sesión caducada en el MCP.');
      }
      const text = await res.text();
      if (!res.ok) {
        const hint = res.status === 403 ? ' (el MCP rechazó la petición: revisa que acepte conexiones locales)' : '';
        throw new Error(`HTTP ${res.status}${hint}: ${text.slice(0, 120) || res.statusText}`);
      }
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream')) return parseSse(text);
      if (!text.trim()) return [];
      const json = JSON.parse(text);
      return Array.isArray(json) ? json : [json];
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(this.#closedByUser ? 'Conexión cerrada.' : `Tiempo de espera agotado en «${label}».`);
      if (err instanceof TypeError) throw new Error(`No se pudo conectar con ${this.server.url}. ¿Está arrancado el MCP?`);
      throw err;
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }
  }

  async #handshake() {
    this.#session = null;
    this.serverInfo = null;
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'web-mcp-bridge', version: chrome.runtime?.getManifest?.().version ?? '1' },
    });
    this.serverInfo = init?.serverInfo ?? { name: 'mcp' };
    this.instructions = typeof init?.instructions === 'string' ? init.instructions : '';
    await this.notify('notifications/initialized');
    await this.refreshTools();
    if (this.#closedByUser) return;
    this.lastError = null;
    this.#attempt = 0;
    this.#setStatus('connected');
    this.#resolveReady();
    this.#startKeepalive();
  }

  /** Conexión perdida mientras estaba conectada: vuelve a empezar. */
  #lost(reason) {
    if (this.#closedByUser) return;
    clearInterval(this.#keepaliveTimer);
    this.tools = [];
    this.lastError = reason;
    if (this.status === 'connected') this.#resetReady();
    this.#setStatus('disconnected');
    this.#scheduleReconnect();
  }

  #startKeepalive() {
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = setInterval(() => {
      this.request('ping', {}, 8000).catch((err) => this.#lost(err.message));
    }, KEEPALIVE_MS);
  }

  #resetReady() {
    this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.#attempt) + Math.random() * 500;
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  #setStatus(next) {
    const prev = this.status;
    this.status = next;
    if (prev !== next) this.onChange({ kind: 'status', prev, next });
  }
}
