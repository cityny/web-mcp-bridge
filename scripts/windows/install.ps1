<#
  install.ps1 - Instala Web MCP Bridge en Windows (puente local + guia para cargar la extension en Chrome).

  Uso (desde la carpeta del repositorio):
      powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1

  Que hace:
    1. Comprueba Python 3.9+ y Git.
    2. Si no existe server\servers.json, lo crea SOLO con el servidor de prueba (demo, puerto 8090).
    3. Ejecuta server\install_service.py: instala dependencias, registra el arranque automatico
       al iniciar sesion y arranca el puente en segundo plano.
    (Antes de 3 detiene un puente anterior, asi se puede volver a ejecutar sin conflictos de puerto.)
    4. Comprueba que el puente responde (canal de descubrimiento 127.0.0.1:8765).
    5. Copia al portapapeles la ruta de la extension y abre chrome://extensions.

  Desinstalar el arranque automatico:
      python server\install_service.py --uninstall
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "  OK  $text" -ForegroundColor Green }
function Fail($text) { Write-Host "  ERROR  $text" -ForegroundColor Red; exit 1 }

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Repo
if (-not (Test-Path (Join-Path $Repo 'manifest.json'))) { Fail "No encuentro manifest.json en $Repo" }

# 1) Python 3.9+ (prueba el lanzador 'py' y luego 'python')
Step 'Comprobando Python'
$Python = $null
foreach ($spec in @('py -3', 'python')) {
  try {
    $words = $spec.Split(' '); $exe = $words[0]; $extra = @($words | Select-Object -Skip 1)
    $version = & $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $version) {
      $parts = $version.Trim().Split('.')
      if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 9) {
        $Python = (& $exe @extra -c "import sys; print(sys.executable)").Trim()
        break
      }
    }
  } catch { }
}
if (-not $Python) { Fail 'Necesitas Python 3.9 o superior: https://www.python.org/downloads/ (marca "Add python.exe to PATH").' }
Ok "Python: $Python"

Step 'Comprobando Git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Necesitas Git: https://git-scm.com/download/win' }
Ok ((git --version) -join '')

# 2) Configuracion minima: solo el servidor demo
Step 'Configuracion de servidores MCP'
$Config = Join-Path $Repo 'server\servers.json'
if (Test-Path $Config) {
  Ok "Se mantiene la configuracion existente: $Config"
} else {
  $demo = Join-Path $Repo 'server\examples\demo_mcp_server.py'
  $json = [ordered]@{ servers = @([ordered]@{ name = 'demo'; port = 8090; command = @($Python, $demo) }) } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($Config, $json, (New-Object System.Text.UTF8Encoding($false)))
  Ok "Creado $Config (solo 'demo'). Editalo para anadir tus MCP: el puente lo recarga solo al guardar."
}

# Un puente anterior ocupando los puertos impediria arrancar el nuevo ("solo se permite un uso de cada direccion")
Step 'Deteniendo un puente anterior (si lo hay)'
$old = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" | Where-Object { $_.CommandLine -like '*mcp_ws_bridge.py*' })
foreach ($proc in $old) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
Ok ("Procesos detenidos: {0}" -f $old.Count)

# 3) Dependencias + arranque automatico + puente en segundo plano
Step 'Instalando el puente (arranque automatico al iniciar sesion)'
& $Python (Join-Path $Repo 'server\install_service.py')
if ($LASTEXITCODE -ne 0) { Fail 'install_service.py fallo (mira el mensaje anterior).' }

# 4) Verificar que el puente escucha
Step 'Comprobando que el puente responde (descubrimiento en 127.0.0.1:8765)'
$listening = $false
for ($i = 0; $i -lt 10 -and -not $listening; $i++) {
  Start-Sleep -Seconds 1
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', 8765); $listening = $client.Connected; $client.Close()
  } catch { }
}
if ($listening) { Ok 'Puente activo.' }
else { Write-Host "  AVISO  El puerto 8765 no responde todavia. Revisa server\bridge.log" -ForegroundColor Yellow }

# 5) Extension en Chrome
Step 'Cargar la extension en Chrome'
Set-Clipboard -Value $Repo
Write-Host "  Ruta de la extension (copiada al portapapeles): $Repo"
Write-Host '  1. En chrome://extensions activa "Modo de desarrollador" (arriba a la derecha).'
Write-Host '  2. Pulsa "Cargar descomprimida" y pega la ruta.'
Write-Host '  3. Abre el popup: detecta solos los MCP de server\servers.json. Activa los que quieras con su interruptor.'
try { Start-Process 'chrome' 'chrome://extensions' } catch { Write-Host '  (Abre Chrome y ve a chrome://extensions manualmente.)' }

Write-Host "`nListo." -ForegroundColor Green
