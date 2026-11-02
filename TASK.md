# TASK

## En curso

## Pendiente
- [ ] Paso 3 — Reforzar adaptador DeepSeek: detección de fin de generación, `getMessageKey` sin coste O(n²), filtro de razonamiento más preciso
- [ ] Paso 4 — Actualizar README (DeepSeek soportado), descripción de `manifest.json` y `package.json`
- [ ] Prueba manual en chat.deepseek.com (Isabel) y registrar fallos observados

## Hecho
- [x] Paso 1 — Base del proyecto: PLANNING/TASK/LOG, dejar de versionar `server/bridge.log`, `*.log` en `.gitignore` (2026-11-02)
- [x] Paso 2 — Parseo tolerante de JSON movido a `utils.js` (`WMB.extractMcpCalls`), con tests; lo usan todos los adaptadores (2026-11-02)
