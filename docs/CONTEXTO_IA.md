# Contexto del proyecto: Web MCP Bridge (fork de Isabel)

> Documento para dar contexto a otra IA. Repositorio: https://github.com/cityny/web-mcp-bridge
> Rama de desarrollo actual: `claude/eager-ptolemy-8kea2p` (los cambios aún NO están en `main`).

## Quién soy y cómo trabajo
- Isabel, construyo productos digitales con IA de forma independiente. Domino n8n, Obsidian, automatizaciones y prompting.
- Trabajo paso a paso: un paso, confirmación, siguiente. Prefiero recomendaciones directas, no listas de opciones.
- Respuestas en español, directas y sin relleno. No asumir contexto que no he dado; si algo no está claro, preguntar.
- No inventar herramientas ni librerías. No eliminar trabajo existente sin que lo pida.
- En el repo: leer `PLANNING.md` al inicio, `TASK.md` antes de cada tarea y registrar decisiones en `LOG.md` con fecha y rol.
- Mi entorno: Windows, Google Chrome, Python 3.14, Git 2.54. Mi carpeta de usuario tiene un espacio: `C:\Users\Dionny Logistic`.

## Qué es el proyecto
Una extensión de Chrome (Manifest V3) más un puente local en Python que permiten que los chats web gratuitos (DeepSeek, ChatGPT, Gemini y Claude) usen servidores MCP que corren en mi PC, sin API keys.

```
Chat web (DeepSeek…)            Mi PC
La IA escribe   ───────────►   Extensión ──WebSocket──► Puente Python ──stdio──► Servidor MCP
{"mcp_call":…}                 (lee, pide permiso)      (mcp_ws_bridge.py)      (el que actúa)
                ◄───────────   resultado como [MCP_RESULT …] [/MCP_RESULT]
```

Las tres piezas:
1. **Servidor MCP**: el programa que hace algo real (leer archivos, controlar una app…). Hoy uso solo `demo` (herramientas `hora_actual`, `sumar` y `eco`).
2. **Puente** (`server/mcp_ws_bridge.py`): traduce WebSocket ↔ stdio. Arranca solo con Windows y lee `server/servers.json` (cada MCP con su nombre, puerto y comando). Solo arranca el proceso MCP cuando la extensión se conecta.
3. **Extensión**:
   - inyecta en el chat las instrucciones con las herramientas disponibles;
   - detecta el bloque `mcp_call` en la respuesta;
   - aplica el permiso de ese MCP (permitir siempre / preguntar / no permitir);
   - ejecuta la llamada vía puente y devuelve el resultado al chat.

En el popup registro cada MCP por su URL (`ws://localhost:<puerto>`). Puedo registrar los que quiera, pero solo 5 pueden estar activos a la vez, porque cada MCP activo consume tokens de contexto. Cada uno se activa o desactiva con un interruptor.

## Estructura del código
| Ruta | Rol |
|---|---|
| `manifest.json` | MV3, permisos y content scripts por plataforma |
| `background/` | Service worker: estado, permisos, historial, cliente WebSocket con reconexión |
| `popup/` | UI: servidores, interruptores, permisos y ajustes |
| `content_scripts/utils.js` | Utilidades DOM y parser tolerante de `mcp_call` (repara comillas tipográficas y barras invertidas) |
| `content_scripts/prompt_builder.js` | Prompt compacto de herramientas y recordatorio por mensaje |
| `content_scripts/core_bridge.js` | Controlador: permisos → ejecución → entrega del resultado |
| `content_scripts/adapters/` | Un adaptador por web; `base_adapter.js` tiene la lógica común |
| `server/` | Puente, instalador de arranque automático y servidor demo |
| `scripts/windows/install.ps1` | Instalador para Windows (probado en mi PC, funciona) |
| `tests/` | `npm test` (parser, prompt, background, puente) y `npm run test:browser` (adaptador DeepSeek en Chromium) |

## Hecho hasta ahora (en la rama de desarrollo)
1. Base del proyecto: `PLANNING.md`, `TASK.md` y `LOG.md`; `bridge.log` deja de versionarse.
2. El parser tolerante de JSON pasa de `chatgpt.js` a `utils.js`, así lo usan todos los adaptadores, incluido DeepSeek. Tiene tests.
3. Adaptador DeepSeek reforzado:
   - filtro de razonamiento (DeepThink) más preciso;
   - filtrado de mensajes anidados con coste lineal;
   - caché de la lista de mensajes;
   - prueba en Chromium con un DOM simulado.
4. Instalación en Windows: `INSTALL.md` + `install.ps1`. Ya instalado y funcionando con `demo` en mi PC.

## Objetivos
- Que funcione de forma fiable con **DeepSeek** (mi plataforma principal).
- Entender bien cómo funciona y tener el proyecto más estructurado y mantenible.
- Usar varios MCP reales en mi PC, por ejemplo uno de archivos de Windows y otro para controlar AutoCAD.

## Mejoras planificadas (en este orden)
- **B. Registro de eventos y errores** para auditorías y depuración:
  - eventos estructurados (fecha, nivel, origen, plataforma, evento y detalles recortados, sin el contenido completo de los mensajes);
  - guardados en el almacenamiento local de la extensión (los últimos ~2.000);
  - exportación a JSON y borrado desde el popup.
- **C. Actualización automática desde `main`**:
  - una tarea programada de Windows hace `git pull` cada pocos minutos;
  - la extensión detecta que la versión en disco cambió y se recarga sola.
  La extensión nunca ejecuta comandos en el PC.
- **D. Gestionar los MCP desde el popup** (hoy hay que editar `servers.json` y volver a ejecutar el instalador):
  - el puente recarga `servers.json` en caliente;
  - el popup añade, edita y quita MCP a través del puente, con clave local, confirmación y registro.

## Pendientes y riesgos conocidos
- Llevar los cambios de la rama de desarrollo a `main` (pull request pendiente de mi aprobación).
- DeepSeek, sin verificar todavía contra el DOM real:
  - la detección de «terminó de generar» usa el crecimiento del texto (2 s);
  - el botón de enviar se localiza por heurística.
- Actualizar el README: todavía dice que DeepSeek está en el roadmap.
- `install_service.py --uninstall` en Windows no detiene `pythonw` (usa `taskkill` por título de ventana).
- Investigar un servidor MCP para AutoCAD fiable (no elegido aún).
- Seguridad: solo conectar MCP de confianza. El MCP de archivos debe limitarse a carpetas concretas, no a `C:\` entero.
