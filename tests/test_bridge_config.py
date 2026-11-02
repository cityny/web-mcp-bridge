"""Pruebas de configuración del puente: formatos de servers.json, descubrimiento y recarga en caliente."""
import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
from mcp_ws_bridge import load_config  # noqa: E402

PY = sys.executable
DEMO = str(ROOT / "server/examples/demo_mcp_server.py")
CONTROL = 18865
OWNER = "chrome-extension://kpjokcdpjbiljllmdobofmomhifebbbo"


def write(path: Path, data) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


def test_formats(tmp: Path) -> None:
    cfg = tmp / "a.json"
    # Formato original
    write(cfg, {"servers": [{"name": "demo", "port": 8090, "command": [PY, DEMO]}]})
    (c,) = load_config(cfg)
    assert (c.name, c.port, c.command) == ("demo", 8090, [PY, DEMO])
    # Formato de Isabel: {nombre: {port, command, args}}
    write(cfg, {"autocad-files": {"port": 8792, "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/x y"]}})
    (c,) = load_config(cfg)
    assert (c.name, c.port, c.command) == ("autocad-files", 8792, ["npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/x y"])
    # Estilo Claude Desktop sin puerto → se asigna desde 8800 sin chocar
    write(cfg, {"mcpServers": {"a": {"command": "x"}, "b": {"command": "y", "port": 8800}}})
    a, b = load_config(cfg)
    assert (a.port, b.port) == (8801, 8800)
    # Errores claros
    for bad in ([1, 2], {"a": {"port": 1}}, {"a": {"command": "x", "port": 9}, "b": {"command": "y", "port": 9}}):
        write(cfg, bad)
        try:
            load_config(cfg)
        except ValueError:
            continue
        raise AssertionError(f"debería fallar: {bad}")


async def discover(origin=None):
    async with websockets.connect(f"ws://127.0.0.1:{CONTROL}", origin=origin) as ws:
        return json.loads(await asyncio.wait_for(ws.recv(), 5))


async def control(request, origin=OWNER):
    async with websockets.connect(f"ws://127.0.0.1:{CONTROL}", origin=origin) as ws:
        await asyncio.wait_for(ws.recv(), 5)  # lista inicial
        await ws.send(json.dumps(request))
        return json.loads(await asyncio.wait_for(ws.recv(), 15))


async def test_editor(cfg: Path) -> None:
    """Leer y escribir servers.json desde la extensión (solo la extensión propietaria)."""
    got = await control({"type": "get_config"})
    assert got["type"] == "config" and json.loads(got["content"]) == json.loads(cfg.read_text()), got
    # Otra extensión o un cliente sin Origin NO pueden leer ni escribir
    for origin in ("chrome-extension://otraextension", None):
        res = await control({"type": "get_config"}, origin)
        assert res == {"type": "result", "ok": False, "error": "no autorizado"}, res
        res = await control({"type": "put_config", "content": "{}"}, origin)
        assert res["ok"] is False
    # Contenido inválido: se rechaza y el archivo NO cambia
    before = cfg.read_text()
    dup_ports = json.dumps({"a": {"command": "x", "port": 1}, "b": {"command": "y", "port": 1}})
    for bad in ("{ roto", '{"a": {"port": 1}}', dup_ports):
        res = await control({"type": "put_config", "content": bad})
        assert res["ok"] is False and res["error"], (bad, res)
    assert cfg.read_text() == before
    # Contenido válido: se guarda, se deja copia .bak y se aplica al momento
    new = {"demo": {"command": PY, "args": [DEMO], "port": 18890}, "extra": {"command": PY, "args": [DEMO], "port": 18892}}
    res = await control({"type": "put_config", "content": json.dumps(new, indent=2)})
    assert res["ok"] is True and sorted(s["name"] for s in res["servers"]) == ["demo", "extra"], res
    assert json.loads(cfg.read_text()) == new
    assert cfg.with_name(cfg.name + ".bak").read_text() == before
    async with websockets.connect("ws://127.0.0.1:18892") as ws:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        assert json.loads(await asyncio.wait_for(ws.recv(), 10))["result"] == {}


async def wait_for(predicate, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if await predicate():
                return True
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(0.3)
    return False


async def test_live(cfg: Path) -> None:
    msg = await discover("chrome-extension://abc")
    assert msg["type"] == "servers"
    assert [(s["name"], s["port"], s["url"]) for s in msg["servers"]] == [("demo", 18890, "ws://localhost:18890")], msg

    # Una web no puede listar los servidores
    try:
        await discover("https://chat.deepseek.com")
        raise AssertionError("una web NO debería poder usar el descubrimiento")
    except (websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidStatus, websockets.exceptions.InvalidHandshake):
        pass

    # Recarga en caliente: se añade un servidor sin reiniciar el puente
    time.sleep(0.05)
    write(cfg, {"demo": {"command": PY, "args": [DEMO], "port": 18890}, "demo2": {"command": PY, "args": [DEMO], "port": 18891}})

    async def two():
        return len((await discover())["servers"]) == 2
    assert await wait_for(two), "no se aplicó la recarga"
    async with websockets.connect("ws://127.0.0.1:18891") as ws:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        assert json.loads(await asyncio.wait_for(ws.recv(), 10))["result"] == {}

    # JSON inválido: se mantiene la configuración anterior
    cfg.write_text("{ roto", encoding="utf-8")
    await asyncio.sleep(3)
    assert len((await discover())["servers"]) == 2

    # Quitar un servidor lo detiene
    write(cfg, {"demo": {"command": PY, "args": [DEMO], "port": 18890}})

    async def one():
        return [s["name"] for s in (await discover())["servers"]] == ["demo"]
    assert await wait_for(one), "no se detuvo el servidor eliminado"


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        test_formats(tmp)
        cfg = tmp / "servers.json"
        write(cfg, {"servers": [{"name": "demo", "port": 18890, "command": [PY, DEMO]}]})
        bridge = subprocess.Popen([PY, str(ROOT / "server/mcp_ws_bridge.py"), "--config", str(cfg), "--control-port", str(CONTROL)],
                                  stderr=subprocess.PIPE)
        try:
            time.sleep(1.5)
            asyncio.run(test_live(cfg))
            asyncio.run(test_editor(cfg))
        finally:
            bridge.terminate()
            bridge.wait(timeout=5)
    print("✔ test_bridge_config: todo correcto")
