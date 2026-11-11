// Pruebas del contenido en crudo @@@ ... @@@ (sin escapar comillas ni saltos de línea).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../content_scripts/utils.js', import.meta.url), 'utf8'), context);
const { WMB } = context;

const html = '<div class="panel">\n  <h1>Hola "mundo"</h1>\n  <script>const a = `x ${1}`; const b = {c: 1};</script>\n</div>';
const msg = '```json\n{"mcp_call":{"server":"f","name":"write_file","arguments":{"path":"C:/a/index.html","content":@@@\n' + html + '\n@@@}}}\n```';
let calls = WMB.extractMcpCalls(msg);
assert.equal(calls.length, 1);
assert.equal(calls[0].arguments.content, html);
assert.equal(calls[0].arguments.path, 'C:/a/index.html');

// Con comillas pegadas a los delimitadores y espacios
calls = WMB.extractMcpCalls('{"mcp_call":{"server":"f","name":"w","arguments":{"content":"@@@ hola "x" @@@"}}}');
assert.equal(calls[0].arguments.content, 'hola "x"');

// Dos bloques en la misma llamada (edit_file)
calls = WMB.extractMcpCalls('{"mcp_call":{"server":"f","name":"edit_file","arguments":{"edits":[{"oldText":@@@\n/*PARTE2*/\n@@@,"newText":@@@\n.a{color:red}\n/*PARTE3*/\n@@@}]}}}');
assert.equal(calls[0].arguments.edits[0].oldText, '/*PARTE2*/');
assert.equal(calls[0].arguments.edits[0].newText, '.a{color:red}\n/*PARTE3*/');

// Compatibilidad: JSON normal con comillas escapadas sigue funcionando
calls = WMB.extractMcpCalls('{"mcp_call":{"server":"f","name":"w","arguments":{"content":"a \\"b\\"\\nc"}}}');
assert.equal(calls[0].arguments.content, 'a "b"\nc');

// Mensaje cortado: @@@ sin cerrar → diagnóstico claro
assert.match(WMB.diagnoseMcpCall('{"mcp_call":{"server":"f","name":"w","arguments":{"content":@@@\n<div>'), /@@@ de cierre/);
console.log('✔ test_raw: todo correcto');
