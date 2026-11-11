"""Pruebas de server/repo_mcp.py (repo-github): varios repos, clonado, archivos por trozos, git y sincronización con GitHub."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server" / "repo_mcp.py"
ENV = {**os.environ, "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.autocrlf", "GIT_CONFIG_VALUE_0": "false", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t.t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t.t"}


def sh(cwd, *cmd):
    return subprocess.run(cmd, cwd=cwd, env=ENV, check=True, capture_output=True, text=True, encoding="utf-8").stdout


with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
    tmp = Path(tmp)
    # «GitHub» falso: dos repos bare + un clon «otro PC» que escribe en el remoto
    remotes, others = {}, {}
    for name in ("u/uno", "u/dos"):
        bare = tmp / "remote" / name.replace("/", "_")
        sh(tmp, "git", "init", "-q", "--bare", "-b", "main", str(bare))
        other = tmp / "otro" / name.replace("/", "_")
        sh(tmp, "git", "clone", "-q", str(bare), str(other))
        (other / "README.md").write_text("uno\n", encoding="utf-8", newline="")
        sh(other, "git", "add", "-A"); sh(other, "git", "commit", "-qm", "inicial"); sh(other, "git", "push", "-q", "-u", "origin", "HEAD:main")
        remotes[name], others[name] = bare, other

    def remote_commit(name, files, msg):
        other = others[name]
        sh(other, "git", "pull", "-q", "--no-rebase", "origin", "main")
        for f, content in files.items():
            (other / f).write_text(content, encoding="utf-8", newline="")
        sh(other, "git", "add", "-A"); sh(other, "git", "commit", "-qm", msg); sh(other, "git", "push", "-q", "origin", "HEAD:main")

    cfg = tmp / "repos.json"
    cfg.write_text(json.dumps({"workspace": str(tmp / "ws"), "repos": {
        "U/Uno": {"token": "tok-secreto", "url": str(remotes["u/uno"])},
        "u/dos": {"token": "tok-secreto", "url": str(remotes["u/dos"])}}}), encoding="utf-8", newline="")

    proc = subprocess.Popen([sys.executable, str(SERVER), "--config", str(cfg)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", env=ENV)
    n = 0

    def rpc(method, params=None):
        global n
        n += 1
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": n, "method": method, "params": params or {}}) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline())["result"]

    def tool(tname, /, **args):
        res = rpc("tools/call", {"name": tname, "arguments": args})
        return res["isError"], res["content"][0]["text"]

    def ok(tname, /, **args):
        err, text = tool(tname, **args)
        assert not err, f"{tname}{args}: {text}"
        return text

    def info(repo):
        return json.loads(ok("sync_check", repo=repo))

    assert rpc("initialize")["serverInfo"]["name"] == "repo-github"
    names = {t["name"] for t in rpc("tools/list")["tools"]}
    assert {"append_file", "edit_file", "git_commit", "github_request", "sync_check", "sync_apply", "list_repos"} <= names

    # Varios repos: hay que indicar cuál; se clonan solos; no se mezclan
    assert tool("read_file", path="README.md")[0] is True  # ambigüedad entre u/uno y u/dos
    assert "sin clonar" in ok("list_repos")
    assert ok("read_file", repo="u/uno", path="README.md") == "uno\n"
    assert ok("read_file", repo="https://github.com/u/dos.git", path="README.md") == "uno\n"
    assert "clonado" in ok("list_repos") and "sin clonar" not in ok("list_repos")
    assert tool("read_file", repo="otro/ajeno", path="README.md")[0] is True  # repo sin token configurado

    # Archivos por trozos con append_file, edición y rutas seguras
    html = '<div class="a">\n  <p>Hola "mundo" ñ</p>\n</div>\n'
    ok("write_file", repo="u/uno", path="panel/index.html", content=html[:20])
    assert "3 líneas" in ok("append_file", repo="u/uno", path="panel/index.html", content=html[20:])
    assert ok("read_file", repo="u/uno", path="panel/index.html") == html
    ok("edit_file", repo="u/uno", path="panel/index.html", oldText="Hola", newText="Adiós")
    assert tool("edit_file", repo="u/uno", path="panel/index.html", oldText="no existe", newText="x")[0] is True
    assert tool("edit_file", repo="u/uno", path="panel/index.html", oldText="div", newText="section")[0] is True  # 2 veces
    ok("edit_file", repo="u/uno", path="panel/index.html", oldText="div", newText="section", replaceAll=True)
    assert tool("write_file", repo="u/uno", path="../fuera.txt", content="x")[0] is True
    assert tool("write_file", repo="u/uno", path=".git/config", content="x")[0] is True
    assert "index.html" in ok("list_directory", repo="u/uno", path="panel")
    assert "index.html:1" in ok("search_text", repo="u/uno", query="section")
    assert not (tmp / "ws" / "u" / "dos" / "panel").exists()  # no se mezcló con el otro repo

    # Sincronización: solo cambios locales → «local»; commit + push → «clean»
    assert info("u/uno")["status"] == "local"
    ok("git_commit", repo="u/uno", message="panel"); ok("git_push", repo="u/uno")
    assert info("u/uno")["status"] == "clean"

    # Caso real: alguien cambia GitHub directamente (mover archivos para Netlify) → «behind» y se actualiza
    remote_commit("u/uno", {"index.html": "<h1>raiz</h1>\n"}, "mover index a la raiz")
    st = info("u/uno")
    assert st["status"] == "behind" and st["behind"] == 1 and any("index.html" in f for f in st["remoteFiles"]), st
    assert "mover index" in st["remoteCommits"][0]
    ok("sync_apply", repo="u/uno", strategy="update")
    assert ok("read_file", repo="u/uno", path="index.html") == "<h1>raiz</h1>\n" and info("u/uno")["status"] == "clean"

    # Divergencia + «usar GitHub»: lo local se respalda (stash) y queda lo de GitHub
    remote_commit("u/uno", {"README.md": "remoto\n"}, "readme remoto")
    ok("write_file", repo="u/uno", path="borrador.txt", content="mi trabajo sin confirmar")
    st = info("u/uno")
    assert st["status"] == "diverged" and st["dirty"], st
    assert tool("sync_apply", repo="u/uno", strategy="update")[0] is True  # update no pisa lo local
    assert "respaldo" in ok("sync_apply", repo="u/uno", strategy="remote")
    assert ok("read_file", repo="u/uno", path="README.md") == "remoto\n" and not (tmp / "ws" / "u" / "uno" / "borrador.txt").exists()
    assert "repo-github-respaldo" in sh(tmp / "ws" / "u" / "uno", "git", "stash", "list")

    # Divergencia + «mantener lo local»: gana lo local donde chocan y llega lo nuevo de GitHub
    remote_commit("u/uno", {"README.md": "remoto 2\n", "nuevo.txt": "de github\n"}, "cambios remotos")
    ok("write_file", repo="u/uno", path="README.md", content="local\n"); ok("git_commit", repo="u/uno", message="readme local")
    assert info("u/uno")["status"] == "diverged"
    ok("sync_apply", repo="u/uno", strategy="local")
    assert ok("read_file", repo="u/uno", path="README.md") == "local\n" and ok("read_file", repo="u/uno", path="nuevo.txt") == "de github\n"
    ok("git_push", repo="u/uno")
    assert info("u/uno")["status"] == "clean"

    # GitHub API: solo rutas del propio repo, y el token nunca aparece
    err, msg = tool("github_request", repo="u/uno", method="GET", path="/repos/otro/ajeno/issues")
    assert err and "tok-secreto" not in msg
    assert tool("github_request", repo="u/uno", method="DELETE", path="/repos/u/uno")[0] is True
    proc.stdin.close()
    proc.wait(timeout=10)

print("test_repo_mcp: todo correcto")
