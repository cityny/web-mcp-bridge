# TASK

## En curso

## Pendiente
- [ ] Probar AutoCAD desde DeepSeek (Isabel)
- [ ] Soporte HTTP nativo (Streamable HTTP) en la extensión: MCP con `"url"` en servers.json sin mcp-proxy (ya no bloquea: mcp-proxy funciona)
- [ ] Punto D (resto) — Interfaz nueva + panel lateral (side panel); decidir si se usa Impeccable
- [ ] Cargar la extensión en Chrome y probar con `demo` en chat.deepseek.com (Isabel)
- [ ] Punto D (resto) — Añadir/editar/quitar MCP desde el popup (escritura de servers.json vía puente, con clave y confirmación)
- [ ] Punto C — Actualización automática desde `main` (tarea programada `git pull` + recarga de la extensión)
- [ ] Llevar los cambios de la rama de desarrollo a `main`
- [ ] Detección de fin de generación en DeepSeek: revisar con el DOM real (¿hay botón «detener» con etiqueta o atributo estable?) antes de tocar `GROW_MS`
- [ ] Paso 4 — Actualizar README (DeepSeek soportado), descripción de `manifest.json` y `package.json`
- [ ] Prueba manual en chat.deepseek.com (Isabel) y registrar fallos observados

## Hecho
- [x] Paso 1 — Base del proyecto: PLANNING/TASK/LOG, dejar de versionar `server/bridge.log`, `*.log` en `.gitignore` (2026-11-02)
- [x] Paso 2 — Parseo tolerante de JSON movido a `utils.js` (`WMB.extractMcpCalls`), con tests; lo usan todos los adaptadores (2026-11-02)
- [x] Paso 3 — DeepSeek: filtro de razonamiento preciso, filtrado de anidados lineal, caché de mensajes, prueba en Chromium (2026-11-02)
- [x] Punto A — Guía `INSTALL.md` y script `scripts/windows/install.ps1` para Windows + Chrome (2026-11-02)
- [x] `install.ps1` probado en el PC de Isabel: Python 3.14, Git 2.54, puente activo en 8090, arranque automático registrado (2026-11-02)
- [x] Punto D (parte 1) — Descubrimiento de MCP del PC desde el popup + recarga en caliente de servers.json + formatos {nombre:{command,args}} y mcpServers (2026-11-02)
- [x] Punto B — Registro de eventos y errores: background/logger.js, pestaña «Registro» con filtro, exportación JSON y borrado (2026-11-02)
- [x] `install_service.py` detiene los puentes anteriores en Windows (instalar y desinstalar) (2026-11-02)
- [x] Punto D (parte 2) — Editor de servers.json en la extensión (plantillas, validación, vista previa, confirmación, .bak); ID fijo de la extensión (2026-11-02)
- [x] AutoCAD (MCP HTTP) conectado vía mcp-proxy: 16 herramientas (2026-11-02)
