#!/usr/bin/env python3
"""
repo_mcp.py — «repo-github»: un MCP (stdio, sin dependencias) para trabajar cualquier repo de GitHub con token.

    python server/repo_mcp.py            # lee server/repos.json (ver repos.example.json)

Archivos + append_file + git + GitHub en uno solo, para VARIOS repos: cada herramienta recibe `repo` ("usuario/nombre";
opcional si solo hay uno configurado). Los repos se clonan solos en la carpeta `workspace`. Antes de trabajar,
`sync_check` compara GitHub con la copia local y `sync_apply` aplica la decisión (la extensión pregunta al usuario).
Los tokens viven solo en repos.json (fuera de git) y nunca aparecen en las respuestas.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG_PATH = Path(__file__).with_name("repos.json")
MAX_READ = 20000
NO_OUTPUT = "(sin salida)"
SECRETS: set = set()


# ───────────────────────── Configuración ─────────────────────────

def load_config():
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise ValueError(f"Falta {CONFIG_PATH}: copia repos.example.json como repos.json y pon tus repos con su token.") from None
    except json.JSONDecodeError as err:
        raise ValueError(f"repos.json no es un JSON válido: {err}") from None
    workspace = Path(raw.get("workspace") or (Path.home() / "repos"))
    repos = {}
    for name, value in (raw.get("repos") or {}).items():
        repos[name.strip().lower()] = {"token": value} if isinstance(value, str) else dict(value or {})
    SECRETS.clear()
    SECRETS.update(e["token"] for e in repos.values() if e.get("token"))
    return workspace, repos


def scrub(text: str) -> str:
    for secret in SECRETS:
        text = text.replace(secret, "***")
    return text


def resolve_repo(args: dict):
    workspace, repos = load_config()
    name = str(args.get("repo") or "").strip().removeprefix("https://github.com/").removesuffix(".git").strip("/").lower()
    if not name:
        if len(repos) != 1:
            raise ValueError(f"Indica repo (usuario/nombre). Configurados: {', '.join(repos) or 'ninguno'}.")
        name = next(iter(repos))
    if name not in repos:
        raise ValueError(f"El repo {name} no está en repos.json. Configurados: {', '.join(repos) or 'ninguno'}.")
    entry = repos[name]
    root = Path(entry["path"]) if entry.get("path") else workspace / name
    return name, entry, root.resolve()


# ───────────────────────── git ─────────────────────────

def git(root: Path, *args: str, token: str = "") -> str:
    cmd = ["git"]
    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        cmd += ["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {basic}"]
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    proc = subprocess.run(cmd + list(args), cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240, env=env)
    out = scrub((proc.stdout + proc.stderr).strip())
    if proc.returncode:
        raise RuntimeError(out or f"git {args[0]} falló ({proc.returncode})")
    return out or NO_OUTPUT


def lines_of(out: str) -> list:
    return [] if out == NO_OUTPUT else [ln for ln in out.splitlines() if ln.strip()]


def ensure_cloned(name: str, entry: dict, root: Path) -> bool:
    """Clona el repo si falta. Devuelve True si acaba de clonarlo."""
    if (root / ".git").exists():
        return False
    if not entry.get("token"):
        raise ValueError(f"El repo {name} no tiene token en repos.json.")
    root.parent.mkdir(parents=True, exist_ok=True)
    url = entry.get("url") or f"https://github.com/{name}.git"
    git(root.parent, "clone", url, str(root), token=entry["token"])
    try:
        git(root, "config", "user.email")
    except RuntimeError:
        git(root, "config", "user.email", "repo-github@users.noreply.github.com")
        git(root, "config", "user.name", "repo-github")
    return True


def has_head(root: Path) -> bool:
    try:
        git(root, "rev-parse", "--verify", "HEAD")
        return True
    except RuntimeError:
        return False


def upstream(root: Path):
    try:
        return git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    except RuntimeError:
        pass
    branch = git(root, "branch", "--show-current")
    ref = f"origin/{branch}"
    try:
        git(root, "rev-parse", "--verify", ref)
        return ref
    except RuntimeError:
        return None


def sync_check(name: str, entry: dict, root: Path) -> str:
    """Compara GitHub con la copia local (hace fetch; no cambia ningún archivo)."""
    if ensure_cloned(name, entry, root):
        return json.dumps({"repo": name, "status": "cloned", "summary": f"{name} clonado desde GitHub."}, ensure_ascii=False)
    try:
        git(root, "fetch", "--prune", "origin", token=entry.get("token", ""))
    except RuntimeError as err:
        return json.dumps({"repo": name, "status": "offline", "summary": f"No se pudo consultar GitHub: {err}"[:300]}, ensure_ascii=False)
    up = upstream(root)
    dirty = lines_of(git(root, "status", "--porcelain"))
    behind = ahead = 0
    remote_files, remote_commits = [], []
    if up:
        if has_head(root):
            behind = int(git(root, "rev-list", "--count", f"HEAD..{up}"))
            ahead = int(git(root, "rev-list", "--count", f"{up}..HEAD"))
            if behind:
                remote_files = lines_of(git(root, "diff", "--name-status", f"HEAD...{up}"))
                remote_commits = lines_of(git(root, "log", "--oneline", "-n", "10", f"HEAD..{up}"))
        else:
            behind = int(git(root, "rev-list", "--count", up))
            remote_files = [f"A\t{f}" for f in lines_of(git(root, "ls-tree", "-r", "--name-only", up))]
    local_changes = bool(dirty) or ahead > 0
    status = "diverged" if behind and local_changes else "behind" if behind else "local" if local_changes else "clean"
    parts = []
    if behind:
        parts.append(f"GitHub tiene {behind} commit(s) nuevo(s): " + "; ".join(remote_commits[:5]))
    if local_changes:
        parts.append(f"Local: {len(dirty)} archivo(s) sin confirmar y {ahead} commit(s) sin subir.")
    info = {"repo": name, "status": status, "behind": behind, "ahead": ahead, "dirty": dirty[:30],
            "remoteFiles": remote_files[:30], "remoteCommits": remote_commits, "summary": " ".join(parts) or "Todo sincronizado."}
    return json.dumps(info, ensure_ascii=False)


def sync_apply(name: str, entry: dict, root: Path, strategy: str) -> str:
    ensure_cloned(name, entry, root)
    token = entry.get("token", "")
    try:
        git(root, "fetch", "--prune", "origin", token=token)
    except RuntimeError as err:
        raise RuntimeError(f"No se pudo consultar GitHub: {err}") from None
    up = upstream(root)
    if not up:
        raise ValueError("No hay rama remota con la que sincronizar.")
    dirty = lines_of(git(root, "status", "--porcelain"))
    head = has_head(root)
    ahead = int(git(root, "rev-list", "--count", f"{up}..HEAD")) if head else 0
    stamp = time.strftime("%Y%m%d-%H%M%S")
    if strategy == "update":
        if dirty or ahead:
            raise ValueError("Hay cambios locales: elige remote (usar GitHub) o local (mantener lo local).")
        git(root, "merge", "--ff-only", up) if head else git(root, "reset", "--hard", up)
        return f"Actualizado desde GitHub ({up})."
    if strategy == "remote":
        notes = []
        if dirty and head:
            git(root, "stash", "push", "-u", "-m", f"repo-github-respaldo-{stamp}")
            notes.append(f"cambios sin confirmar guardados en 'git stash' (repo-github-respaldo-{stamp})")
        if ahead:
            git(root, "branch", f"respaldo/local-{stamp}")
            notes.append(f"commits locales guardados en la rama respaldo/local-{stamp}")
        git(root, "reset", "--hard", up)
        return f"Ahora la copia local es la de GitHub ({up})." + (" Respaldo: " + "; ".join(notes) + "." if notes else "")
    if strategy == "local":
        stashed = bool(dirty) and head
        if stashed:
            git(root, "stash", "push", "-u", "-m", f"repo-github-respaldo-{stamp}")
        try:
            git(root, "merge", "-X", "ours", "--no-edit", up)
        except RuntimeError as err:
            try:
                git(root, "merge", "--abort")
            except RuntimeError:
                pass
            if stashed:
                git(root, "stash", "pop")
            raise ValueError(f"No se pudo mezclar solo ({err}). Usa remote: lo local queda respaldado.") from None
        if stashed:
            try:
                git(root, "stash", "pop")
            except RuntimeError:
                raise ValueError("Mezclado, pero tus cambios sin confirmar chocan con lo nuevo: quedan guardados en 'git stash'.") from None
        return f"Mezclado lo nuevo de GitHub ({up}) conservando lo local donde chocaban."
    raise ValueError("strategy debe ser update, remote o local.")


# ───────────────────────── Herramientas ─────────────────────────

S = {"type": "string"}


def obj(props: dict, required: list | None = None) -> dict:
    return {"type": "object", "properties": {"repo": S, **props}, "required": required or []}


TOOLS = [
    ("list_repos", "Repos configurados (usuario/nombre) y si ya están clonados.", {"type": "object", "properties": {}}),
    ("read_file", "Lee un archivo de texto. repo = usuario/nombre (opcional si solo hay uno).", obj({"path": S, "max_chars": {"type": "number"}}, ["path"])),
    ("write_file", "Crea o reemplaza un archivo. Si es grande, escribe el primer trozo aquí y el resto con append_file.", obj({"path": S, "content": S}, ["path", "content"])),
    ("append_file", "Añade texto al final de un archivo (lo crea si no existe): para los trozos siguientes de un archivo grande.", obj({"path": S, "content": S}, ["path", "content"])),
    ("edit_file", "Cambia oldText por newText (oldText debe ser único, salvo replaceAll).", obj({"path": S, "oldText": S, "newText": S, "replaceAll": {"type": "boolean"}}, ["path", "oldText", "newText"])),
    ("list_directory", "Lista archivos y carpetas (path vacío = raíz).", obj({"path": S})),
    ("search_text", "Busca un texto en los archivos (máx. 50 resultados).", obj({"query": S, "path": S}, ["query"])),
    ("git_status", "Estado de git.", obj({})),
    ("git_diff", "Diferencias sin confirmar (opcional: un archivo).", obj({"path": S})),
    ("git_branch", "Crea y cambia a una rama, o cambia a una existente.", obj({"name": S}, ["name"])),
    ("git_commit", "Commit de todos los cambios.", obj({"message": S}, ["message"])),
    ("git_push", "Sube la rama actual (o la indicada) a GitHub.", obj({"branch": S})),
    ("sync_check", "Compara GitHub con la copia local (la extensión lo usa antes de trabajar).", obj({})),
    ("sync_apply", "Aplica la decisión de sincronización: update, remote (usar GitHub) o local (mantener lo local).", obj({"strategy": S}, ["strategy"])),
    ("github_request", "API de GitHub del repo: method y path que empieza con /repos/<repo>/ (issues, pulls, contents…). body opcional.", obj({"method": S, "path": S, "body": {"type": "object"}}, ["method", "path"])),
]


def safe(root: Path, path: str) -> Path:
    p = Path(path or ".")
    p = (p if p.is_absolute() else root / p).resolve()
    if p != root and root not in p.parents:
        raise ValueError(f"Ruta fuera del repo: {path}")
    if ".git" in p.relative_to(root).parts:
        raise ValueError("No se permite tocar la carpeta .git")
    return p


def count(text: str) -> str:
    return f"{len(text)} caracteres, {text.count(chr(10)) + (1 if text and not text.endswith(chr(10)) else 0)} líneas"


def read_text(p: Path) -> str:
    with open(p, encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


def call_tool(tool: str, a: dict) -> str:
    if tool == "list_repos":
        workspace, repos = load_config()
        rows = []
        for name, entry in repos.items():
            root = Path(entry["path"]) if entry.get("path") else workspace / name
            rows.append(f"{name}  [{'clonado' if (root / '.git').exists() else 'sin clonar'}]  {root.as_posix()}")
        return "\n".join(rows) or "No hay repos en repos.json."
    name, entry, root = resolve_repo(a)
    token = entry.get("token", "")
    if tool == "sync_check":
        return sync_check(name, entry, root)
    if tool == "sync_apply":
        return sync_apply(name, entry, root, str(a.get("strategy", "")))
    ensure_cloned(name, entry, root)
    if tool == "read_file":
        text = read_text(safe(root, a["path"]))
        limit = int(a.get("max_chars") or MAX_READ)
        return text if len(text) <= limit else text[:limit] + f"\n[... recortado: {len(text)} caracteres en total]"
    if tool in ("write_file", "append_file"):
        p = safe(root, a["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        content = str(a["content"])
        with open(p, "w" if tool == "write_file" else "a", encoding="utf-8", newline="") as fh:
            fh.write(content)
        verb = "Escrito" if tool == "write_file" else f"Añadido (+{len(content)} caracteres) a"
        return f"{verb} {p.relative_to(root).as_posix()}. Ahora tiene {count(read_text(p))}."
    if tool == "edit_file":
        p = safe(root, a["path"])
        text, old = read_text(p), str(a["oldText"])
        found = text.count(old)
        if not old or not found:
            raise ValueError("oldText no aparece en el archivo (debe coincidir exacto, con espacios y saltos de línea).")
        if found > 1 and not a.get("replaceAll"):
            raise ValueError(f"oldText aparece {found} veces; añade más contexto o usa replaceAll.")
        with open(p, "w", encoding="utf-8", newline="") as fh:
            fh.write(text.replace(old, str(a["newText"])))
        return f"Editado {p.relative_to(root).as_posix()} ({found} cambio{'s' if found > 1 else ''})."
    if tool == "list_directory":
        rows = sorted(safe(root, a.get("path", "")).iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        return "\n".join(f"{'[D]' if x.is_dir() else '[F]'} {x.name}" for x in rows if x.name != ".git") or "(vacía)"
    if tool == "search_text":
        q, hits = str(a["query"]).lower(), []
        for f in safe(root, a.get("path", "")).rglob("*"):
            if len(hits) >= 50:
                break
            if not f.is_file() or ".git" in f.parts or f.stat().st_size > 1_000_000:
                continue
            try:
                for n, line in enumerate(read_text(f).splitlines(), 1):
                    if q in line.lower():
                        hits.append(f"{f.relative_to(root).as_posix()}:{n}: {line.strip()[:160]}")
            except OSError:
                pass
        return "\n".join(hits[:50]) or "Sin resultados."
    if tool == "git_status":
        return git(root, "status", "-sb")
    if tool == "git_diff":
        return git(root, "diff", "--", a["path"]) if a.get("path") else git(root, "diff")
    if tool == "git_branch":
        exists = git(root, "branch", "--list", a["name"]) != NO_OUTPUT
        return git(root, "switch", a["name"]) if exists else git(root, "switch", "-c", a["name"])
    if tool == "git_commit":
        git(root, "add", "-A")
        return git(root, "commit", "-m", a["message"])
    if tool == "git_push":
        branch = a.get("branch") or git(root, "branch", "--show-current")
        return git(root, "push", "-u", "origin", branch, token=token)
    if tool == "github_request":
        path, method = str(a["path"]), str(a["method"]).upper()
        if not (path == f"/repos/{name}" or path.lower().startswith(f"/repos/{name}/")):
            raise ValueError(f"Solo se permite /repos/{name}/…")
        if method not in ("GET", "POST", "PATCH", "PUT"):
            raise ValueError("Método no permitido (GET, POST, PATCH o PUT).")
        data = json.dumps(a["body"]).encode() if a.get("body") is not None else None
        req = urllib.request.Request("https://api.github.com" + path, data=data, method=method, headers={
            "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "repo-github-mcp", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return scrub(resp.read().decode("utf-8", "replace"))[:MAX_READ]
        except urllib.error.HTTPError as err:
            raise RuntimeError(f"GitHub {err.code}: {scrub(err.read().decode('utf-8', 'replace'))[:1500]}") from None
    raise KeyError(tool)


def reply(msg_id, result=None, error=None) -> None:
    body = {"jsonrpc": "2.0", "id": msg_id}
    body.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(body, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    global CONFIG_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="")
    CONFIG_PATH = Path(ap.parse_args().config) if ap.parse_args().config else CONFIG_PATH
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
            reply(msg_id, {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "repo-github", "version": "2.0.0"}})
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
