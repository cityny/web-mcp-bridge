# TASK

## En curso

## Pendiente
- [ ] Detección de fin de generación en DeepSeek: revisar con el DOM real (¿hay botón «detener» con etiqueta o atributo estable?) antes de tocar `GROW_MS`
- [ ] Paso 4 — Actualizar README (DeepSeek soportado), descripción de `manifest.json` y `package.json`
- [ ] Prueba manual en chat.deepseek.com (Isabel) y registrar fallos observados

## Hecho
- [x] Paso 1 — Base del proyecto: PLANNING/TASK/LOG, dejar de versionar `server/bridge.log`, `*.log` en `.gitignore` (2026-11-02)
- [x] Paso 2 — Parseo tolerante de JSON movido a `utils.js` (`WMB.extractMcpCalls`), con tests; lo usan todos los adaptadores (2026-11-02)
- [x] Paso 3 — DeepSeek: filtro de razonamiento preciso, filtrado de anidados lineal, caché de mensajes, prueba en Chromium (2026-11-02)
