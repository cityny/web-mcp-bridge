# Instalación en Windows + Chrome

Guía para instalar Web MCP Bridge en tu PC y probarlo. Tarda unos 10 minutos.

## Requisitos (una sola vez)

| Programa | Dónde | Nota |
|---|---|---|
| Git | https://git-scm.com/download/win | Opciones por defecto |
| Python 3.9+ | https://www.python.org/downloads/ | Marca **«Add python.exe to PATH»** |
| Google Chrome 116+ | — | |

Comprueba en PowerShell:

```powershell
git --version
py -3 --version
```

## 1. Descargar el repositorio

Elige una carpeta fija: Chrome cargará la extensión desde ahí y la actualización automática trabajará sobre ella. No la muevas después.

```powershell
cd $HOME
git clone https://github.com/cityny/web-mcp-bridge.git
cd web-mcp-bridge
git checkout main
```

> Mientras los cambios del fork no estén en `main`, usa la rama de desarrollo:
> `git checkout claude/eager-ptolemy-8kea2p`

## 2. Instalar el puente local

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
```

El script:

1. Comprueba Python y Git.
2. Crea `server\servers.json` solo con el servidor de prueba `demo` (puerto 8090), si no existe.
3. Detiene un puente anterior, si lo hay (evita el error «solo se permite un uso de cada dirección»).
4. Instala dependencias, registra el arranque automático al iniciar sesión y arranca el puente en segundo plano.
5. Comprueba que el puente responde (canal de descubrimiento, puerto 8765), copia la ruta de la extensión al portapapeles y abre `chrome://extensions`.

## 3. Cargar la extensión en Chrome

1. En `chrome://extensions` activa **Modo de desarrollador** (arriba a la derecha).
2. **Cargar descomprimida** → pega la ruta (la carpeta del repositorio, donde está `manifest.json`).
3. Fija el icono de la extensión en la barra (icono de puzle → chincheta).
4. Abre el popup: detecta solos los MCP de `server\servers.json` y los añade **desactivados**. Activa los que quieras con su interruptor (máximo 5 a la vez). Botón **Detectar MCP del PC** para volver a leerlos.

## 4. Probar

1. Entra en https://chat.deepseek.com (o ChatGPT, Gemini, Claude).
2. Escribe: *«¿Qué hora es? Usa tus herramientas.»* y envía. La extensión añade las instrucciones automáticamente al primer mensaje.
3. La IA responde con un bloque `mcp_call` → aparece el panel de aprobación → **Ejecutar**.
4. El resultado vuelve al chat y la IA contesta con la hora.

Herramientas del demo: `hora_actual`, `sumar(a, b)`, `eco(texto)`.

## Añadir tus propios MCP

1. Edita `server\servers.json` con el Bloc de notas y guarda. **El puente lo recarga solo** (no hace falta reiniciar ni volver a ejecutar el script).
2. Abre el popup: el MCP nuevo aparece desactivado. Actívalo con su interruptor.

Formatos admitidos (puedes usar cualquiera):

```json
{
  "demo":          { "command": "python", "args": ["server/examples/demo_mcp_server.py"], "port": 8090 },
  "autocad-files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/Dionny Logistic/autocad-mcp"], "port": 8792 }
}
```

- También vale `{"mcpServers": {...}}` (estilo Claude Desktop) y el formato original `{"servers": [...]}`.
- Si no pones `port`, se asigna uno libre a partir de 8800.
- Cada MCP necesita un puerto distinto.
- Si guardas un JSON con errores, el puente sigue con la configuración anterior y lo anota en `server\bridge.log`.
- No ejecutes tú el MCP en la terminal (`npx ...`): lo arranca el puente cuando lo activas en la extensión.

## Problemas frecuentes

| Síntoma | Qué mirar |
|---|---|
| El servidor sale en rojo en el popup | `server\bridge.log`; vuelve a ejecutar el script de instalación |
| «La extensión se actualizó: recarga la pestaña» | Recarga la pestaña del chat (F5) |
| La IA no usa la herramienta | Botón **Inyectar instrucciones** en el panel del chat |
| `py` no se reconoce | Reinstala Python marcando «Add python.exe to PATH» |

## Desinstalar

```powershell
py -3 server\install_service.py --uninstall
```

Después quita la extensión en `chrome://extensions`.
