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
5. Comprueba que el puerto 8090 responde, copia la ruta de la extensión al portapapeles y abre `chrome://extensions`.

## 3. Cargar la extensión en Chrome

1. En `chrome://extensions` activa **Modo de desarrollador** (arriba a la derecha).
2. **Cargar descomprimida** → pega la ruta (la carpeta del repositorio, donde está `manifest.json`).
3. Fija el icono de la extensión en la barra (icono de puzle → chincheta).
4. Abre el popup → **Añadir servidor de prueba (demo, ws://localhost:8090)**. Debe ponerse en verde.

## 4. Probar

1. Entra en https://chat.deepseek.com (o ChatGPT, Gemini, Claude).
2. Escribe: *«¿Qué hora es? Usa tus herramientas.»* y envía. La extensión añade las instrucciones automáticamente al primer mensaje.
3. La IA responde con un bloque `mcp_call` → aparece el panel de aprobación → **Ejecutar**.
4. El resultado vuelve al chat y la IA contesta con la hora.

Herramientas del demo: `hora_actual`, `sumar(a, b)`, `eco(texto)`.

## Añadir tus propios MCP

Edita `server\servers.json` (ejemplos en `server\servers.example.json`), vuelve a ejecutar `scripts\windows\install.ps1` y registra cada servidor en el popup con su `ws://localhost:<puerto>`.

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
