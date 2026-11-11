#!/usr/bin/env python3
"""
repo_mcp.py — Un solo MCP (stdio, sin dependencias) para trabajar un repositorio: archivos + git + GitHub.

    python server/repo_mcp.py --root C:/ruta/al/repo --repo usuario/repositorio

Une lo que antes eran tres servidores (filesystem, git y github) y añade `append_file`, que permite escribir
archivos grandes por trozos sin marcadores. Todo queda limitado a la carpeta --root.
El token de GitHub se lee de la variable de entorno GITHUB_PERSONAL_ACCESS_TOKEN (nunca se muestra).
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT: Path = Path.cwd()
REPO = ""
TOKEN = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN", "")
MAX_READ = 20000
NO_OUTPUT = "(sin salida)"


def obj(props: dict, required: list | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


S = {"type": "string"}
TOOLS = [
    ("read_file", "Lee un archivo de texto del repo.", obj({"path": S, "max_chars": {"type": "number"}}, ["path"])),
    ("write_file", "Crea o reemplaza un archivo (crea carpetas). Para archivos grandes escribe el primer trozo aquí y el resto con append_file.", obj({"path": S, "content": S}, ["path", "content"])),
    ("append_file", "Añade texto al final de un archivo (lo crea si no existe). Úsalo para los trozos siguientes de un archivo grande.", obj({"path": S, "content": S}, ["path", "content"])),
    ("edit_file", "Cambia oldText por newText en un archivo (oldText debe ser único, salvo replaceAll).", obj({"path": S, "oldText": S, "newText": S, "replaceAll": {"type": "boolean"}}, ["path", "oldText", "newText"])),
    ("list_directory", "Lista archivos y carpetas (path vacío = raíz del repo).", obj({"path": S})),
    ("search_text", "Busca un texto en los archivos del repo (máx. 50 resultados).", obj({"query": S, "path": S}, ["query"])),
    ("git_status", "Estado de git (rama y archivos cambiados).", obj({})),
    ("git_diff", "Diferencias sin confirmar (opcional: un archivo).", obj({"path": S})),
    ("git_branch", "Crea y cambia a una rama nueva, o cambia a una existente.", obj({"name": S}, ["name"])),
    ("git_commit", "Hace commit de todos los cambios con ese mensaje.", obj({"message": S}, ["message"])),
    ("git_push", "Sube la rama actual (o la indicada) a GitHub.", obj({"branch": S})),
    ("github_request", "Llamada a la API de GitHub del repo configurado: method y path que empieza con /repos/<repo>/ (issues, pulls, contents…). body opcional.", obj({"method": S, "path": S, "body": {"type": "object"}}, ["method", "path"])),
]


def safe(path: str) -> Path:
    p = Path(path or ".")
    p = (p if p.is_absolute() else ROOT / p).resolve()
    if p != ROOT and ROOT not in p.parents:
        raise ValueError(f"Ruta fuera del repo: {path}")
    if ".git" in p.relative_to(ROOT).parts:
        raise ValueError("No se permite tocar la carpeta .git")
    return p


def scrub(text: str) -> str:
    return text.replace(TOKEN, "***") if TOKEN else text


def git(*args: str, auth: bool = False) -> str:
    cmd = ["git"]
    if auth:
        if not TOKEN:
            raise ValueError("Falta GITHUB_PERSONAL_ACCESS_TOKEN en la configuración del MCP.")
        basic = base64.b64encode(f"x-access-token:{TOKEN}".encode()).decode()
        cmd += ["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {basic}"]
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    proc = subprocess.run(cmd + list(args), cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, env=env)
    out = scrub((proc.stdout + proc.stderr).strip())
    if proc.returncode:
        raise RuntimeError(out or f"git {args[0]} falló ({proc.returncode})")
    return out or NO_OUTPUT


def count(text: str) -> str:
    return f"{len(text)} caracteres, {text.count(chr(10)) + (1 if text and not text.endswith(chr(10)) else 0)} líneas"


def read_text(p: Path) -> str:
    with open(p, encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


def call_tool(name: str, a: dict) -> str:
    if name == "read_file":
        text = read_text(safe(a["path"]))
        limit = int(a.get("max_chars") or MAX_READ)
        return text if len(text) <= limit else text[:limit] + f"\n[... recortado: {len(text)} caracteres en total]"
    if name in ("write_file", "append_file"):
        p = safe(a["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        content = str(a["content"])
        with open(p, "w" if name == "write_file" else "a", encoding="utf-8", newline="") as fh:
            fh.write(content)
        total = read_text(p)
        verb = "Escrito" if name == "write_file" else f"Añadido (+{len(content)} caracteres) a"
        return f"{verb} {p.relative_to(ROOT).as_posix()}. Ahora tiene {count(total)}."
    if name == "edit_file":
        p = safe(a["path"])
        text, old = read_text(p), str(a["oldText"])
        found = text.count(old)
        if not old or not found:
            raise ValueError("oldText no aparece en el archivo (debe coincidir exacto, con espacios y saltos de línea).")
        if found > 1 and not a.get("replaceAll"):
            raise ValueError(f"oldText aparece {found} veces; añade más contexto o usa replaceAll.")
        with open(p, "w", encoding="utf-8", newline="") as fh:
            fh.write(text.replace(old, str(a["newText"])))
        return f"Editado {p.relative_to(ROOT).as_posix()} ({found} cambio{'s' if found > 1 else ''})."
    if name == "list_directory":
        p = safe(a.get("path", ""))
        rows = sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        return "\n".join(f"{'[D]' if x.is_dir() else '[F]'} {x.name}" for x in rows if x.name != ".git") or "(vacía)"
    if name == "search_text":
        q, hits = str(a["query"]).lower(), []
        for f in safe(a.get("path", "")).rglob("*"):
            if len(hits) >= 50:
                break
            if not f.is_file() or ".git" in f.parts or f.stat().st_size > 1_000_000:
                continue
            try:
                for n, line in enumerate(read_text(f).splitlines(), 1):
                    if q in line.lower():
                        hits.append(f"{f.relative_to(ROOT).as_posix()}:{n}: {line.strip()[:160]}")
            except OSError:
                pass
        return "\n".join(hits[:50]) or "Sin resultados."
    if name == "git_status":
        return git("status", "-sb")
    if name == "git_diff":
        return git("diff", "--", a["path"]) if a.get("path") else git("diff")
    if name == "git_branch":
        exists = git("branch", "--list", a["name"]) != NO_OUTPUT
        return git("switch", a["name"]) if exists else git("switch", "-c", a["name"])
    if name == "git_commit":
        git("add", "-A")
        return git("commit", "-m", a["message"])
    if name == "git_push":
        branch = a.get("branch") or git("branch", "--show-current").strip()
        return git("push", "-u", "origin", branch, auth=True)
    if name == "github_request":
        if not TOKEN or not REPO:
            raise ValueError("Falta el token de GitHub o --repo en la configuración del MCP.")
        path, method = str(a["path"]), str(a["method"]).upper()
        if not path.startswith(f"/repos/{REPO}/") and path != f"/repos/{REPO}":
            raise ValueError(f"Solo se permite /repos/{REPO}/…")
        if method not in ("GET", "POST", "PATCH", "PUT"):
            raise ValueError("Método no permitido (GET, POST, PATCH o PUT).")
        data = json.dumps(a["body"]).encode() if a.get("body") is not None else None
        req = urllib.request.Request("https://api.github.com" + path, data=data, method=method, headers={
            "Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json", "User-Agent": "repo-mcp", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return scrub(resp.read().decode("utf-8", "replace"))[:MAX_READ]
        except urllib.error.HTTPError as err:
            raise RuntimeError(f"GitHub {err.code}: {scrub(err.read().decode('utf-8', 'replace'))[:1500]}") from None
    raise KeyError(name)


def reply(msg_id, result=None, error=None) -> None:
    body = {"jsonrpc": "2.0", "id": msg_id}
    body.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(body, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    global ROOT, REPO
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--repo", default="")
    args = ap.parse_args()
    ROOT, REPO = Path(args.root).resolve(), args.repo
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    listing = [{"name": n, "description": d, "inputSchema": s} for n, d, s in TOOLS]
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        method, msg_id = msg.get("method"), msg.get("id")
        if msg_id is None:
            continue
        if method == "initialize":
            reply(msg_id, {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "repo-mcp", "version": "1.0.0"}})
        elif method == "tools/list":
            reply(msg_id, {"tools": listing})
        elif method == "tools/call":
            params = msg.get("params", {})
            try:
                text = call_tool(params["name"], params.get("arguments") or {})
                reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
            except Exception as err:  # noqa: BLE001
                reply(msg_id, {"content": [{"type": "text", "text": f"Error: {scrub(str(err))}"}], "isError": True})
        elif method == "ping":
            reply(msg_id, {})
        else:
            reply(msg_id, error={"code": -32601, "message": f"Método no soportado: {method}"})


if __name__ == "__main__":
    main()
