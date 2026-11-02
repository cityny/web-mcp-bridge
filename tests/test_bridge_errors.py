"""El puente explica por qué se cae un MCP: comando inexistente o MCP que termina con error al arrancar."""
import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


async def close_reason(port: int) -> tuple[int, str]:
    async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
        try:
            while True:
                await asyncio.wait_for(ws.recv(), 10)
        except websockets.exceptions.ConnectionClosed as err:
            rcvd = err.rcvd
            return (rcvd.code, rcvd.reason) if rcvd else (0, "")
    return (0, "")


async def main() -> None:
    code, reason = await close_reason(18901)
    assert code == 1011 and "no-existe-mcp-xyz" in reason, (code, reason)
    code, reason = await close_reason(18902)
    assert code == 1011 and "código 3" in reason and "fallo de prueba" in reason, (code, reason)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as d:
        cfg = Path(d) / "servers.json"
        cfg.write_text(json.dumps({
            "falta": {"command": "no-existe-mcp-xyz", "port": 18901},
            "falla": {"command": PY, "args": ["-c", "import sys; print('fallo de prueba: sin conexión', file=sys.stderr); sys.exit(3)"], "port": 18902},
        }), encoding="utf-8")
        bridge = subprocess.Popen([PY, str(ROOT / "server/mcp_ws_bridge.py"), "--config", str(cfg), "--control-port", "0"], stderr=subprocess.PIPE)
        try:
            time.sleep(1.5)
            asyncio.run(main())
        finally:
            bridge.terminate()
            bridge.wait(timeout=5)
    print("✔ test_bridge_errors: todo correcto")
