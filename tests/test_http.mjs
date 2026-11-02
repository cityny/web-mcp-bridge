// Pruebas del cliente MCP por HTTP (Streamable HTTP) con fetch simulado: SSE, sesión, 202 y servidor reiniciado.
import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { getManifest: () => ({ version: 'test' }) } };
const calls = [];
let session = 'S1';
let forget = false;
globalThis.fetch = async (url, { method, headers, body }) => {
  const msg = body ? JSON.parse(body) : null;
  calls.push({ method, session: headers?.['Mcp-Session-Id'] ?? null, rpc: msg?.method });
  const sse = (obj) => new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': session } });
  if (method === 'DELETE') return new Response(null, { status: 200 });
  if (forget && msg.method !== 'initialize') { forget = false; return new Response('Session not found', { status: 404 }); }
  if (!msg.id) return new Response(null, { status: 202 });
  const results = {
    initialize: { serverInfo: { name: 'autocad' }, capabilities: {} },
    'tools/list': { tools: [{ name: 'captura', inputSchema: { type: 'object' } }, { name: 'zoom' }] },
    'tools/call': { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] },
    ping: {},
  };
  if (msg.method === 'tools/call' && msg.params.name === 'falla') return sse({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'AutoCAD no está abierto' } });
  return sse({ jsonrpc: '2.0', id: msg.id, result: results[msg.method] });
};

const { HttpMcpConnection, parseSse } = await import('../background/http_client.js');

// 1) SSE con varios eventos y líneas data: múltiples
assert.deepEqual(parseSse('event: a\ndata: {"x":1}\n\ndata: {"y":\ndata: 2}\n\n: comentario\n\n'), [{ x: 1 }, { y: 2 }]);

// 2) Conexión: initialize → initialized (202) → tools/list; la sesión se reenvía
const events = [];
const conn = new HttpMcpConnection({ id: 'a', name: 'autocad', url: 'http://127.0.0.1:8765/mcp' }, (e) => events.push(e));
conn.connect();
assert.equal(await conn.whenReady(2000), true);
assert.equal(conn.status, 'connected');
assert.equal(conn.serverInfo.name, 'autocad');
assert.deepEqual(conn.tools.map((t) => t.name), ['captura', 'zoom']);
assert.deepEqual(calls.map((c) => c.rpc), ['initialize', 'notifications/initialized', 'tools/list']);
assert.equal(calls[0].session, null);
assert.ok(calls.slice(1).every((c) => c.session === 'S1'), 'la sesión se envía tras initialize');

// 3) Llamada a herramienta (imagen) y error del servidor
const shot = await conn.callTool('captura', {});
assert.equal(shot.content[0].type, 'image');
await assert.rejects(conn.callTool('falla', {}), /AutoCAD no está abierto/);

// 4) El servidor se reinicia y olvida la sesión (404) → se reconecta solo con sesión nueva
session = 'S2';
forget = true;
await assert.rejects(conn.callTool('zoom', {}), /Sesión caducada/);
assert.notEqual(conn.status, 'connected');
await new Promise((r) => setTimeout(r, 3000)); // reintento con backoff
assert.equal(conn.status, 'connected', 'reconecta tras el reinicio del MCP');
assert.equal(calls.at(-1).session, 'S2');

// 5) Puerta cerrada: no se hace ninguna petición
const before = calls.length;
const gated = new HttpMcpConnection({ id: 'b', name: 'x', url: 'http://127.0.0.1:1/mcp' }, () => {}, () => 'no configurado');
gated.connect();
assert.equal(gated.status, 'error');
assert.equal(gated.lastError, 'no configurado');
assert.equal(calls.length, before);
gated.close();

// 6) Cerrar: DELETE de la sesión
conn.close();
assert.equal(calls.at(-1).method, 'DELETE');
console.log('✔ test_http: todo correcto');
process.exit(0);
