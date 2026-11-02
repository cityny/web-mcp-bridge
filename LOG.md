# LOG

## 2026-11-02 — Claude (asistente de desarrollo)
- Evaluación inicial del fork. Tests: 4 suites JS OK; `test_bridge.py` OK tras instalar `websockets`.
- Hallazgos DeepSeek: sin reparación de JSON (solo existe en `chatgpt.js`), streaming detectado por crecimiento de texto (2 s), botón enviar por heurística, filtro de razonamiento amplio, `getMessageKey` O(n²), sin tests.
- Decisión: trabajar por pasos (ver TASK.md). Primero higiene del repo y documentación base.
- `server/bridge.log` deja de versionarse (contenía rutas locales del autor original); el archivo local se conserva. Se añade `*.log` a `.gitignore`.

## 2026-11-02 — Claude (asistente de desarrollo) · Paso 2
- La reparación de barras invertidas (`fixString`, `repairBackslashes`) pasa de `chatgpt.js` a `utils.js`. `scanCalls` usa `parseLenient`: primero `JSON.parse` normal y, solo si falla, reintenta con las barras reparadas. Se aplica al fragmento JSON de cada llamada, no al texto entero (menos riesgo con comillas en la prosa).
- Decisión: eliminar `findJsonObjects` y el texto «reparado» que `messageText` añadía en ChatGPT; el parser compartido ya cubre esos casos. Beneficia a DeepSeek, Claude y Gemini sin tocar sus adaptadores.
- Tests nuevos en `tests/test_utils.mjs` (ruta Windows, escapes válidos conservados, comillas tipográficas + barras). Verificado que fallan con el parser anterior.
- Límite conocido: si el JSON roto sigue siendo válido (p. ej. `"C:\new"` se lee como salto de línea) no se detecta. El prompt ya pide usar `/` en rutas.

## 2026-11-02 — Claude (asistente de desarrollo) · Paso 3
- Filtro de razonamiento: `.ds-think-content` se mantiene; las clases genéricas pasan de subcadena (`[class*="think"]`) a palabra completa (`think`, `thinking`, `deepthink`, `reasoning`) y solo en 6 ancestros sin llegar a `<body>`. Motivo: una clase global como `thinking-enabled` o `unthinkable` marcaba todas las respuestas como razonamiento; el adaptador anterior caía entonces al modo «sin filtrar» e incluía también el razonamiento.
- Filtrado de contenedores anidados: de O(n²) a lineal (recorrido de ancestros con Set).
- Caché de `getAssistantMessages()` de 150 ms (se invalida si algún elemento sale del DOM): `getMessageKey` e `isStreaming` dejan de recalcular la lista en cada llamada dentro del mismo análisis.
- Decisión: NO cambiar la detección de fin de generación (`GROW_MS`) ni la heurística del botón enviar sin ver el DOM real; queda en TASK.md.
- Nueva prueba `tests/browser/test_deepseek.mjs` (Playwright, DOM simulado): filtrado, línea base, llamada nueva una sola vez, repintado sin duplicar, ruta Windows. Falla con el adaptador anterior, pasa con el nuevo. Fuera de `npm test` porque CI no tiene Chromium.

## 2026-11-02 — Claude (asistente de desarrollo) · Instalación en Windows
- Requisitos de Isabel: Windows, Chrome, actualizaciones desde la rama `main`. Nuevos objetivos: A) instalar en su PC, B) registro de eventos para auditoría, C) actualización automática.
- A: `INSTALL.md` + `scripts/windows/install.ps1`. Reutiliza `server/install_service.py` (arranque automático vía carpeta Inicio) en lugar de duplicarlo.
- Decisión: el script crea `servers.json` solo con `demo`; el `default_config()` del instalador Python incluye `astrax-mcp`, que no está instalado y fallaría al conectar.
- Decisión: el script detiene puentes anteriores (`mcp_ws_bridge.py` vía CIM) antes de arrancar; reejecutar el instalador causaba «puerto en uso» (visto en el bridge.log original). `install_service.py --uninstall` usa `taskkill` por título de ventana, que no encuentra `pythonw`: pendiente de revisar.
- `.ps1` guardado en UTF-8 con BOM y CRLF (`.gitattributes`) para PowerShell 5.1. No se pudo ejecutar aquí (sin PowerShell): requiere prueba en Windows.

## 2026-11-02 — Isabel (usuaria) / Claude · Prueba de instalación
- `scripts/windows/install.ps1` ejecutado en Windows (usuario con espacio en la ruta): todos los pasos OK, puente escuchando en 127.0.0.1:8090.
- Incidencia de uso: al clonar se queda en `main`, que no tiene el script. Se resolverá llevando los cambios a `main`.

## 2026-11-02 — Claude (asistente de desarrollo) · Descubrimiento de MCP y recarga en caliente
- Petición de Isabel: que la extensión lea los MCP del PC y ella elija cuáles activar; su `servers.json` usa el formato `{nombre: {port, command, args}}`, que el puente NO aceptaba (fallaba al arrancar).
- Puente (`mcp_ws_bridge.py`):
  - acepta `{"servers": [...]}`, `{"mcpServers": {...}}` y `{nombre: {...}}`, con `command` como texto o lista más `args`;
  - asigna un puerto automático (desde 8800) si falta y valida nombres y puertos repetidos;
  - recarga `servers.json` en caliente cada 2 s (`BridgeManager.apply`: arranca los nuevos, detiene los quitados y reinicia los cambiados). Con un JSON inválido mantiene la configuración anterior;
  - abre un canal de descubrimiento de solo lectura en `ws://127.0.0.1:8765` (solo con `--config`): envía `{type:"servers", servers:[{name,port,url}]}`. Sigue la misma regla de Origin que los MCP (solo extensiones).
- Extensión: mensaje `DISCOVER_SERVERS`; el popup detecta al abrirse (en silencio) y con el botón «Detectar MCP del PC». Los MCP nuevos se registran DESACTIVADOS (decide Isabel); no se duplican por puerto.
- Decisión: el descubrimiento NO expone los comandos, solo nombre y puerto. Escribir `servers.json` desde el popup queda para más adelante, con clave y confirmación.
- `install.ps1` comprueba ahora el puerto 8765 en vez del 8090 (el demo puede no estar en su configuración).
- Pruebas: `tests/test_bridge_config.py` (formatos, descubrimiento, rechazo de una web, recarga, JSON inválido, quitar un servidor) y una prueba manual automatizada con la extensión real en Chromium: detección → activar → «Conectado».

## 2026-11-02 — Claude (asistente de desarrollo) · Conflicto de puerto del descubrimiento
- En el PC de Isabel el puerto 8765 ya lo usa otro programa: el canal de descubrimiento no arrancaba y la comprobación de `install.ps1` daba un falso «Puente activo», porque solo probaba la conexión TCP y respondía el otro programa.
- Decisión: mover el canal de descubrimiento a 47615 (puerto poco común y fuera del rango efímero de Windows, que empieza en 49152).
- `install.ps1` comprueba ahora la respuesta real del puente (`type: "servers"`) con Python + websockets y lista los MCP configurados. Verificado contra el puente real (OK) y contra otro programa en el puerto (rechazado).
- El log explica que, si el puerto está ocupado, los MCP siguen funcionando pero no se pueden detectar.
- Nota: en PowerShell 5.1, `Get-Content` necesita `-Encoding UTF8` para leer bien `bridge.log`.

## 2026-11-02 — Claude (asistente de desarrollo) · Fallo de install.ps1 en PowerShell 5.1
- Error en el PC de Isabel: `python -c $probe` → SyntaxError. PowerShell 5.1 quita las comillas dobles de los argumentos que pasa a programas nativos, y además `2>$null` con `$ErrorActionPreference = 'Stop'` corta el script ante cualquier salida en stderr.
- Solución: la comprobación pasa a un archivo propio, `scripts/windows/check_bridge.py`, y durante esa llamada se usa `ErrorActionPreference = 'Continue'`. Probado contra el puente real (lista los MCP) y sin puente (código 1).
- Lección: en scripts .ps1 no pasar código con `-c` a programas nativos; usar archivos.

## 2026-11-02 — Claude (asistente de desarrollo) · Punto B: registro de eventos
- Isabel aprueba el plan: 1) pull request a `main`, B) registros, D) interfaz nueva + panel lateral, C) actualización automática.
- `background/logger.js`: entradas `{ts, level, source, event, platform?, details?}`, anillo de 2.000 en `chrome.storage.local` (`wmb_logs`), escrituras agrupadas cada 500 ms. Los detalles se recortan (300 caracteres por texto, profundidad 3).
- Qué se registra:
  - arranque del service worker;
  - conexión, caída y herramientas de cada MCP (sin repetir el mismo error en cada reintento);
  - llamadas a herramientas (servidor, herramienta, argumentos recortados, duración y error);
  - acciones del popup (activar, permisos, ajustes, detectar…);
  - eventos del chat: llamada detectada, aprobación, resultado entregado, fallos y todo lo que muestra el panel flotante.
  No se registran las consultas frecuentes (GET_STATE, SLEEP…) ni el texto de los mensajes del usuario.
- Popup: nueva pestaña «Registro» con filtro por nivel, exportación a JSON (versión + navegador + eventos) y borrado con confirmación. Es provisional: se integrará en la interfaz nueva del punto D.
- Error visto por Isabel (`ws://127.0.0.1:8765 … 404`): la extensión no se había recargado tras el cambio de puerto.
- `install_service.py` en Windows detiene ahora los puentes anteriores con PowerShell `-EncodedCommand` + CIM, tanto al instalar como al desinstalar. Antes, ejecutarlo directamente arrancaba un segundo puente y `--uninstall` no paraba `pythonw`. No probado en Windows.
- Pruebas: `test_background` (eventos, recorte, origen, borrado) y prueba con la extensión real en Chromium (pestaña Registro + exportación).
