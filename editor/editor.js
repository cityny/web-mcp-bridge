/**
 * editor.js — Editor de los MCP del PC (server/servers.json) desde la extensión.
 *
 * Lee y guarda la configuración a través del canal de control del puente local (solo esta extensión está
 * autorizada). Valida antes de guardar, muestra exactamente qué comandos se ejecutarán y pide confirmación
 * para los nuevos o modificados.
 */
const $ = (selector) => document.querySelector(selector);
const AUTO_PORT_START = 8800; // igual que el puente (mcp_ws_bridge.py)

let original = '';      // contenido tal como está guardado
let originalByName = new Map();

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
  toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}

function setMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

// ───────────── Interpretación (misma lógica que load_config del puente) ─────────────

/** Convierte cualquiera de los formatos admitidos a [{name, port, auto, command[]}]. Lanza Error si no es válido. */
export function normalize(data) {
  let entries;
  if (data && typeof data === 'object' && Array.isArray(data.servers)) {
    entries = data.servers.map((e) => ({ ...e }));
  } else {
    const mapping = data && typeof data === 'object' && !Array.isArray(data) ? (data.mcpServers ?? data) : null;
    if (!mapping || typeof mapping !== 'object') throw new Error('Formato no reconocido: usa {"nombre": {"command": …}}.');
    entries = Object.entries(mapping).map(([name, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`«${name}» debe ser un objeto con al menos "command".`);
      return { name, ...entry };
    });
  }
  const used = new Set(entries.filter((e) => e.port != null).map((e) => Number(e.port)));
  let next = AUTO_PORT_START;
  const names = new Set();
  const out = entries.map((e) => {
    const name = String(e.name ?? '').trim();
    if (!name) throw new Error('Cada MCP necesita un nombre.');
    if (names.has(name)) throw new Error(`Nombre repetido: «${name}».`);
    names.add(name);
    let command = typeof e.command === 'string' ? [e.command] : Array.isArray(e.command) ? [...e.command] : [];
    command = command.concat((e.args ?? []).map(String));
    if (!command.length) throw new Error(`«${name}» no tiene "command".`);
    let port = e.port;
    const auto = port == null;
    if (auto) { while (used.has(next)) next += 1; port = next; used.add(next); }
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`«${name}»: el puerto no es válido.`);
    return { name, port, auto, command };
  });
  const ports = out.map((e) => e.port);
  const dup = ports.filter((p, i) => ports.indexOf(p) !== i);
  if (dup.length) throw new Error(`Puertos repetidos: ${[...new Set(dup)].join(', ')}.`);
  return out;
}

const VALID_ESCAPE = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/** Recorre el texto marcando las barras invertidas que NO forman un escape JSON válido (rutas de Windows pegadas). */
function scanBackslashes(text, fix = false) {
  let out = '';
  let loose = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = text[i + 1];
    if (next === '\\') { out += fix ? '/' : '\\\\'; i += 1; continue; } // «\\» = una barra escrita bien: en rutas, mejor «/»
    if (next !== undefined && VALID_ESCAPE.has(next)) { out += ch + next; i += 1; continue; }
    loose = true;
    out += fix ? '/' : ch;
  }
  return { loose, text: out };
}

const looseBackslash = (text) => scanBackslashes(text).loose;

function parseContent(text) {
  try {
    return { data: JSON.parse(text) };
  } catch (err) {
    const hint = looseBackslash(text) ? ' Parece una ruta de Windows con «\\»: usa «/» (botón «Cambiar \\ por /»).' : '';
    return { error: `JSON no válido: ${err.message}.${hint}` };
  }
}

const commandLine = (cmd) => cmd.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');

// ───────────── Vista previa y validación ─────────────

function validate() {
  const text = $('#content').value;
  const status = $('#status');
  const tbody = $('#preview');
  tbody.replaceChildren();
  $('#fix-slashes').hidden = !looseBackslash(text);

  const parsed = parseContent(text);
  let entries = null;
  if (parsed.error) setMsg(status, parsed.error, 'err');
  else {
    try {
      entries = normalize(parsed.data);
      setMsg(status, `✔ Configuración válida · ${entries.length} MCP${text === original ? '' : ' · cambios sin guardar'}`, 'ok');
    } catch (err) { setMsg(status, err.message, 'err'); }
  }
  $('#save').disabled = !entries || text === original;

  for (const e of entries ?? []) {
    const tr = document.createElement('tr');
    const before = originalByName.get(e.name);
    const changed = !before || before !== commandLine(e.command);
    if (changed) tr.className = 'changed';
    const cells = [e.name, e.auto ? `${e.port} (auto)` : String(e.port), commandLine(e.command), changed ? (before ? 'modificado' : 'nuevo') : ''];
    cells.forEach((value, i) => {
      const td = document.createElement('td');
      if (i === 3 && value) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = value; td.append(tag); } else td.textContent = value;
      tr.append(td);
    });
    tbody.append(tr);
  }
  return entries;
}

// ───────────── Cargar y guardar ─────────────

async function load() {
  try {
    const { content, path } = await api('GET_BRIDGE_CONFIG');
    original = content;
    $('#content').value = content;
    $('#path').textContent = path;
    try { originalByName = new Map(normalize(JSON.parse(content)).map((e) => [e.name, commandLine(e.command)])); } catch { originalByName = new Map(); }
  } catch (err) {
    $('#path').textContent = 'No se pudo leer la configuración';
    setMsg($('#status'), `${err.message} Comprueba que el puente esté en marcha (scripts\\windows\\install.ps1) y recarga esta página.`, 'err');
  }
  validate();
}

async function save() {
  const entries = validate();
  if (!entries) return;
  const changed = entries.filter((e) => originalByName.get(e.name) !== commandLine(e.command));
  const removed = [...originalByName.keys()].filter((name) => !entries.some((e) => e.name === name));
  const lines = [
    ...changed.map((e) => `• ${e.name} (puerto ${e.port}): ${commandLine(e.command)}`),
    ...removed.map((name) => `• ${name}: se elimina`),
  ];
  if (lines.length && !confirm(`Se guardarán estos cambios y tu PC podrá ejecutar estos comandos cuando actives el MCP:\n\n${lines.join('\n')}\n\n¿Continuar?`)) return;

  $('#save').disabled = true;
  try {
    const { servers } = await api('PUT_BRIDGE_CONFIG', { content: $('#content').value });
    original = $('#content').value;
    originalByName = new Map(entries.map((e) => [e.name, commandLine(e.command)]));
    let added = [];
    try { added = (await api('DISCOVER_SERVERS')).added ?? []; } catch { /* el popup lo volverá a intentar */ }
    toast(`Guardado: ${servers.length} MCP en el puente.${added.length ? ` Nuevos en la extensión: ${added.join(', ')} (actívalos en el popup).` : ''}`);
  } catch (err) {
    setMsg($('#status'), `No se guardó: ${err.message}`, 'err');
    toast('No se guardó la configuración.');
  }
  validate();
}

// ───────────── Plantillas ─────────────

function updateTemplateFields() {
  const type = $('#tpl-type').value;
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== type;
}

function buildTemplate() {
  const type = $('#tpl-type').value;
  const name = $('#tpl-name').value.trim();
  if (!name) throw new Error('Escribe un nombre.');
  const slash = (v) => v.trim().replace(/\\/g, '/');
  let entry;
  if (type === 'folder') {
    const folder = slash($('#tpl-folder').value);
    if (!folder) throw new Error('Indica la carpeta.');
    entry = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', folder] };
  } else if (type === 'http') {
    const url = $('#tpl-url').value.trim();
    if (!/^https?:\/\//.test(url)) throw new Error('La dirección debe empezar por http:// o https://');
    entry = { command: 'mcp-proxy', args: ['--transport=streamablehttp', url] };
  } else {
    const command = slash($('#tpl-command').value);
    if (!command) throw new Error('Indica el comando.');
    entry = { command, args: $('#tpl-args').value.split('\n').map((a) => a.trim()).filter(Boolean) };
  }
  const port = $('#tpl-port').value.trim();
  if (port) entry.port = Number(port);
  return { name, entry };
}

function addTemplate() {
  const msg = $('#tpl-msg');
  try {
    const { name, entry } = buildTemplate();
    const parsed = parseContent($('#content').value.trim() || '{}');
    if (parsed.error) throw new Error('Corrige primero el JSON del editor.');
    const data = parsed.data;
    if (Array.isArray(data?.servers)) {
      if (data.servers.some((s) => s.name === name)) throw new Error(`Ya existe «${name}».`);
      data.servers.push({ name, ...entry, command: [entry.command, ...entry.args], args: undefined });
    } else {
      const target = data.mcpServers ?? data;
      if (name in target) throw new Error(`Ya existe «${name}».`);
      target[name] = entry;
    }
    $('#content').value = `${JSON.stringify(data, null, 2)}\n`;
    validate();
    setMsg(msg, `Añadido «${name}». Revisa la vista previa y pulsa Guardar.`, 'ok');
  } catch (err) {
    setMsg(msg, err.message, 'err');
  }
}

// ───────────── Eventos ─────────────

$('#content').addEventListener('input', validate);
$('#content').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { // sangría con Tab en lugar de saltar de campo
    e.preventDefault();
    const el = e.target;
    const { selectionStart: start, selectionEnd: end } = el;
    el.setRangeText('  ', start, end, 'end');
    validate();
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!$('#save').disabled) save(); }
});
$('#save').addEventListener('click', save);
$('#reload').addEventListener('click', () => {
  if ($('#content').value !== original && !confirm('Hay cambios sin guardar. ¿Descartarlos?')) return;
  load();
});
$('#fix-slashes').addEventListener('click', () => {
  $('#content').value = scanBackslashes($('#content').value, true).text;
  validate();
});
$('#format').addEventListener('click', () => {
  const parsed = parseContent($('#content').value);
  if (parsed.error) { setMsg($('#status'), parsed.error, 'err'); return; }
  $('#content').value = `${JSON.stringify(parsed.data, null, 2)}\n`;
  validate();
});
$('#tpl-type').addEventListener('change', updateTemplateFields);
$('#tpl-add').addEventListener('click', addTemplate);
window.addEventListener('beforeunload', (e) => { if ($('#content').value !== original) e.preventDefault(); });

updateTemplateFields();
load();
