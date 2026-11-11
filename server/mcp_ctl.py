#!/usr/bin/env python3
"""
mcp_ctl.py — Controla desde la terminal los MCP que gestiona el puente (server/servers.json).

    py -3 server\\mcp_ctl.py list
    py -3 server\\mcp_ctl.py stop  repo-github     # lo detiene (el puente lo apaga al instante; queda en servers.json)
    py -3 server\\mcp_ctl.py start repo-github     # lo vuelve a arrancar
    py -3 server\\mcp_ctl.py remove demo           # lo borra de servers.json (la extensión ya no lo vuelve a detectar)

Detener = poner "disabled": true: el puente aplica el cambio en caliente (no hace falta reiniciarlo).
Antes de cada cambio se guarda una copia en servers.json.bak. El nombre se acepta con - o _ indistintamente.
Para parar TODO el puente: py -3 server\\install_service.py --uninstall
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path


def norm(value) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")


def container(data):
    """Devuelve ('list', lista) o ('map', dict) según el formato del archivo."""
    if isinstance(data, dict) and isinstance(data.get("servers"), list):
        return "list", data["servers"]
    if isinstance(data, dict) and isinstance(data.get("mcpServers"), dict):
        return "map", data["mcpServers"]
    if isinstance(data, dict):
        return "map", data
    raise ValueError("servers.json debe ser un objeto JSON")


def entries(data):
    kind, box = container(data)
    if kind == "list":
        return [(str(e.get("name", "")), e) for e in box if isinstance(e, dict)]
    return [(k, v) for k, v in box.items() if isinstance(v, dict)]


def find(data, name: str):
    items = entries(data)
    for key, entry in items:
        if key == name:
            return key, entry
    matches = [(k, e) for k, e in items if norm(k) == norm(name)]
    if len(matches) == 1:
        return matches[0]
    raise KeyError(name if not matches else f"{name} (ambiguo: {', '.join(k for k, _ in matches)})")


def describe(entry) -> str:
    if entry.get("url") and not entry.get("command"):
        return entry["url"]
    return f"puerto {entry['port']}" if entry.get("port") is not None else "puerto automático"


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description="Detener, arrancar o quitar MCP del puente desde la terminal.")
    ap.add_argument("action", choices=["list", "stop", "start", "remove"])
    ap.add_argument("name", nargs="?", help="nombre del MCP (como en servers.json)")
    ap.add_argument("--config", type=Path, default=Path(__file__).with_name("servers.json"))
    args = ap.parse_args(argv)
    try:
        data = json.loads(args.config.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as err:
        print(f"No se pudo leer {args.config}: {err}", file=sys.stderr)
        return 2

    if args.action == "list":
        rows = entries(data)
        width = max((len(k) for k, _ in rows), default=4)
        for key, entry in rows:
            print(f"{key:<{width}}  {'detenido' if entry.get('disabled') else 'activo  '}  {describe(entry)}")
        if not rows:
            print("No hay MCP en servers.json.")
        return 0

    if not args.name:
        print(f"Indica el nombre del MCP: mcp_ctl.py {args.action} NOMBRE", file=sys.stderr)
        return 2
    try:
        key, entry = find(data, args.name)
    except KeyError as err:
        names = ", ".join(k for k, _ in entries(data)) or "ninguno"
        print(f"No existe el MCP {err.args[0]}. Disponibles: {names}.", file=sys.stderr)
        return 1

    shutil.copyfile(args.config, args.config.with_name(args.config.name + ".bak"))
    kind, box = container(data)
    if args.action == "stop":
        entry["disabled"] = True
        message = f"'{key}' detenido. El puente lo apaga en unos segundos; 'start' lo reanuda."
    elif args.action == "start":
        entry.pop("disabled", None)
        message = f"'{key}' reanudado. El puente lo arranca en unos segundos."
    else:
        if kind == "list":
            box.remove(entry)
        else:
            del box[key]
        message = f"'{key}' quitado de servers.json. Ya no se vuelve a detectar (copia en servers.json.bak)."
    args.config.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
