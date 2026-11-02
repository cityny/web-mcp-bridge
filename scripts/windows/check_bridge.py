"""Comprueba que el puente Web MCP Bridge responde en el canal de descubrimiento y lista sus MCP.

Sale con código 0 si responde el PUENTE (no otro programa en el mismo puerto); 1 en caso contrario.
Uso: python scripts/windows/check_bridge.py [puerto]
"""
import asyncio
import json
import sys

import websockets

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 47615


async def main() -> str:
    async with websockets.connect(f"ws://127.0.0.1:{PORT}", open_timeout=3) as ws:
        msg = json.loads(await asyncio.wait_for(ws.recv(), 3))
    if msg.get("type") != "servers":
        raise ValueError("respuesta inesperada")
    return ", ".join(f"{s['name']} ({s['port']})" for s in msg["servers"]) or "(ninguno)"


if __name__ == "__main__":
    try:
        print(asyncio.run(main()))
    except Exception:  # noqa: BLE001
        sys.exit(1)
