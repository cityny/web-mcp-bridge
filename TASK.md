# TASK

## En curso

## Pendiente
- [ ] Deduplicación de llamadas en conversaciones largas de DeepSeek: capturar HTML real (mensajes de usuario) antes de cambiarla (ver LOG)
- [ ] Fusionar el PR #2 y cambiar la carpeta de Isabel a `main` (`git checkout main`) para que funcione la actualización automática
- [ ] Probar en Windows: tarea programada `WebMCPBridge-Update` y recarga automática de la extensión
- [ ] Probar AutoCAD desde DeepSeek (Isabel)
- [ ] Cambiar `autocad` a HTTP directo en el PC de Isabel (editor → `{"url": "http://127.0.0.1:8765/mcp"}`) y probar
- [ ] Ampliar herramientas del MCP de AutoCAD (¿repo `cityny/rive-llm`? pendiente de confirmar)
- [ ] Cargar la extensión en Chrome y probar con `demo` en chat.deepseek.com (Isabel)
- [ ] Punto D (resto) — Añadir/editar/quitar MCP desde el popup (escritura de servers.json vía puente, con clave y confirmación)
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
- [x] Punto D — Interfaz nueva (MCP / Actividad / Ajustes) y panel lateral (2026-11-02)
- [x] Punto C — Actualización automática: `update.ps1` + tarea programada + recarga de la extensión por `update-stamp.json` (2026-11-02)
- [x] Soporte HTTP nativo (Streamable HTTP) en la extensión, sin mcp-proxy (2026-11-02)
