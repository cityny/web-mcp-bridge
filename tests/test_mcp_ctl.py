"""Pruebas de server/mcp_ctl.py (detener/arrancar/quitar MCP) y de "disabled" en el puente."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
from mcp_ws_bridge import load_config  # noqa: E402

CTL = str(ROOT / "server" / "mcp_ctl.py")


def ctl(cfg: Path, *args):
    proc = subprocess.run([sys.executable, CTL, *args, "--config", str(cfg)], capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    return proc.returncode, proc.stdout + proc.stderr


with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
    cfg = Path(tmp) / "servers.json"
    base = {
        "demo": {"command": "python", "args": ["demo.py"], "port": 8090},
        "repo-github": {"command": "python", "args": ["repo.py"], "port": 8793},
        "autocad": {"url": "http://127.0.0.1:8765/mcp"},
    }
    cfg.write_text(json.dumps(base), encoding="utf-8")
    names = lambda: [c.name for c in load_config(cfg)]  # noqa: E731

    code, out = ctl(cfg, "list")
    assert code == 0 and "demo" in out and "repo-github" in out and "activo" in out and "puerto 8793" in out, out
    assert names() == ["demo", "repo-github", "autocad"]

    # stop: lo deja en el archivo pero el puente deja de arrancarlo; acepta guion o guion bajo
    code, out = ctl(cfg, "stop", "repo_github")
    assert code == 0 and "detenido" in out, out
    assert names() == ["demo", "autocad"]
    assert json.loads(cfg.read_text(encoding="utf-8"))["repo-github"]["disabled"] is True
    assert "detenido" in ctl(cfg, "list")[1]
    assert json.loads(cfg.with_name("servers.json.bak").read_text(encoding="utf-8")) == base  # copia previa al cambio

    # start: vuelve a arrancar
    assert ctl(cfg, "start", "repo-github")[0] == 0
    assert names() == ["demo", "repo-github", "autocad"]
    assert "disabled" not in json.loads(cfg.read_text(encoding="utf-8"))["repo-github"]

    # remove: lo borra del archivo (para que la extensión no lo vuelva a detectar)
    code, out = ctl(cfg, "remove", "demo")
    assert code == 0 and "quitado" in out, out
    assert names() == ["repo-github", "autocad"] and "demo" not in cfg.read_text(encoding="utf-8")

    # errores claros
    code, out = ctl(cfg, "stop", "no-existe")
    assert code == 1 and "Disponibles: repo-github, autocad" in out, out
    assert ctl(cfg, "stop")[0] == 2

    # otros formatos de servers.json: {"servers": [...]} y {"mcpServers": {...}}
    cfg.write_text(json.dumps({"servers": [{"name": "a", "port": 8101, "command": ["x"]}, {"name": "b", "port": 8102, "command": ["y"]}]}), encoding="utf-8")
    assert ctl(cfg, "stop", "a")[0] == 0 and names() == ["b"]
    assert ctl(cfg, "remove", "b")[0] == 0 and json.loads(cfg.read_text(encoding="utf-8"))["servers"][0]["name"] == "a"
    cfg.write_text(json.dumps({"mcpServers": {"c": {"command": "z", "port": 8103}}}), encoding="utf-8")
    assert ctl(cfg, "stop", "c")[0] == 0 and names() == []

print("test_mcp_ctl: todo correcto")
