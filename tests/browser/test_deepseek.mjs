// Prueba del adaptador DeepSeek en Chromium (Playwright) con un DOM SIMULADO de chat.deepseek.com.
// No sustituye la prueba manual en la web real: verifica la lógica del adaptador, no los selectores actuales de DeepSeek.
// Uso: npm run test:browser  (requiere Playwright + Chromium instalados; no forma parte de `npm test`/CI).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('⚠ test_deepseek: Playwright no está instalado, prueba omitida.');
  process.exit(0);
}

const root = new URL('../../', import.meta.url);
const scripts = ['content_scripts/utils.js', 'content_scripts/adapters/base_adapter.js', 'content_scripts/adapters/deepseek.js']
  .map((f) => readFileSync(new URL(f, root), 'utf8'));

const HTML = `<!doctype html><html><body class="thinking-enabled">
<div id="chat">
  <div class="msg"><div class="ds-think-content"><div class="ds-markdown">razonamiento {"mcp_call":{"server":"demo","name":"hora"}}</div></div>
    <div class="ds-markdown" id="a1">Respuesta antigua {"mcp_call":{"server":"demo","name":"vieja"}}</div></div>
  <div class="msg"><div class="ds-thinking-box"><div class="ds-markdown">otro razonamiento</div></div>
    <div class="unthinkable"><div class="ds-markdown" id="a2">Respuesta normal</div></div></div>
  <div class="msg"><div class="ds-markdown" id="outer"><div class="ds-markdown" id="inner">anidado</div></div></div>
</div>
<textarea id="chat-input"></textarea>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto('https://chat.deepseek.com/a/chat/s/test-conv');
  for (const code of scripts) await page.addScriptTag({ content: code });

  // 1) Filtrado: sin razonamiento, sin contenedores anidados, sin falsos positivos («unthinkable», clase global del <body>)
  const ids = await page.evaluate(() => WMB.findAdapter('chat.deepseek.com').getAssistantMessages().map((el) => el.id));
  assert.deepEqual(ids, ['a1', 'a2', 'inner']);

  // 2) Observación: lo antiguo no se ejecuta; una llamada nueva se ejecuta UNA vez aunque la página repinte el mensaje
  await page.evaluate(() => {
    window.calls = [];
    WMB.findAdapter('chat.deepseek.com').observeResponses((d) => window.calls.push(d.call.name));
  });
  await page.waitForTimeout(3000); // fin de la línea base
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = '<div class="ds-markdown" id="new">Voy a usarla ```json {"mcp_call":{"server":"demo","name":"sumar","arguments":{"a":1}}} ```</div>';
    document.getElementById('chat').appendChild(div);
  });
  await page.waitForTimeout(4000);
  assert.deepEqual(await page.evaluate(() => window.calls), ['sumar']);

  await page.evaluate(() => { // repintado: mismo contenido, elemento nuevo
    const old = document.getElementById('new');
    const copy = old.cloneNode(true);
    old.replaceWith(copy);
  });
  await page.waitForTimeout(4000);
  assert.deepEqual(await page.evaluate(() => window.calls), ['sumar'], 'el repintado no debe repetir la llamada');

  // 3) Ruta de Windows con barras sueltas (parser compartido)
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.className = 'msg';
    const bs = String.fromCharCode(92); // UNA barra invertida suelta, como la deja el Markdown
    div.innerHTML = `<div class="ds-markdown" id="win">{"mcp_call":{"server":"fs","name":"leer","arguments":{"ruta":"C:${bs}Users${bs}Ana"}}}</div>`;
    document.getElementById('chat').appendChild(div);
  });
  await page.waitForTimeout(4000);
  assert.equal(await page.evaluate(() => document.getElementById('win').textContent.split(String.fromCharCode(92)).length - 1), 2);
  assert.deepEqual(await page.evaluate(() => window.calls), ['sumar', 'leer']);

  console.log('✔ test_deepseek: todo correcto');
} finally {
  await browser.close();
}
