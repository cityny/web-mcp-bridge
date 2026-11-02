# PLANNING — Web MCP Bridge (fork de cityny)

## Objetivo del fork
Evaluar, entender y mejorar Web MCP Bridge, con foco en que funcione de forma fiable con **DeepSeek** (chat.deepseek.com) y en dejar el proyecto más estructurado y mantenible.

## Qué es
Extensión de navegador (Manifest V3) que permite a chats web sin MCP (ChatGPT, Gemini, Claude, DeepSeek) usar servidores MCP locales:

```
Web de chat ── content script + adaptador
     │ detecta {"mcp_call":{...}} en la respuesta de la IA
     ▼
Service worker (background/) ── WebSocket ──► server/mcp_ws_bridge.py ── stdio ──► servidor MCP
     ▲                                                     │
     └──────── resultado al chat como [MCP_RESULT …] ◄─────┘
```

## Arquitectura
| Ruta | Rol |
|---|---|
| `manifest.json` | Declaración MV3, permisos y content scripts por plataforma |
| `background/background.js` | Service worker: estado, permisos, historial, enrutado de llamadas |
| `background/ws_client.js` | Cliente MCP sobre WebSocket con reconexión |
| `shared/constants.js` | Constantes compartidas (ajustes por defecto, límites, URLs soportadas) |
| `content_scripts/utils.js` | Utilidades: DOM, parser de `mcp_call`, formateo de resultados |
| `content_scripts/prompt_builder.js` | Instrucciones y recordatorio que se inyectan en el chat |
| `content_scripts/ui_widget.js` | Panel flotante dentro del chat |
| `content_scripts/core_bridge.js` | Controlador: permisos → ejecución → entrega del resultado |
| `content_scripts/adapters/base_adapter.js` | Lógica común de observación, envío y adjuntos |
| `content_scripts/adapters/*.js` | Selectores y particularidades de cada plataforma |
| `popup/` | Configuración de servidores, permisos y ajustes |
| `server/mcp_ws_bridge.py` | Puente WebSocket ↔ stdio hacia servidores MCP |
| `tests/`, `scripts/` | Tests (`npm test`), validador, empaquetado |

## Principios
- Un adaptador nuevo debería ser, idealmente, solo selectores; la lógica reutilizable vive en `utils.js` / `base_adapter.js`.
- Sin dependencias en la extensión (JS plano, sin bundler).
- Cada cambio con tests cuando la lógica sea testeable sin navegador.
- No eliminar trabajo existente sin indicación explícita.

## Limitaciones conocidas
- Las pruebas reales contra chat.deepseek.com requieren navegador con sesión iniciada: se hacen manualmente.
- `tests/test_bridge.py` requiere `pip install -r server/requirements.txt`.

## Comandos
- `npm test` — validación + tests JS + test del puente Python
- `npm run pack` — genera `dist/web-mcp-bridge.zip`
