"""Pruebas de server/repo_mcp.py: archivos, trozos con append_file, ruta segura y git local."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server" / "repo_mcp.py"

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "t@t.t"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=root, check=True)
    proc = subprocess.Popen([sys.executable, str(SERVER), "--root", str(root), "--repo", "u/r"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")
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

    assert rpc("initialize")["serverInfo"]["name"] == "repo-mcp"
    names = {t["name"] for t in rpc("tools/list")["tools"]}
    assert {"write_file", "append_file", "edit_file", "git_commit", "github_request"} <= names

    html = '<div class="a">\n  <p>Hola "mundo" ñ</p>\n</div>\n'
    assert tool("write_file", path="panel/index.html", content=html[:20]) [0] is False
    err, msg = tool("append_file", path="panel/index.html", content=html[20:])
    assert not err and "3 líneas" in msg, msg
    assert (root / "panel" / "index.html").read_text(encoding="utf-8") == html
    assert tool("read_file", path="panel/index.html")[1] == html

    assert tool("edit_file", path="panel/index.html", oldText="Hola", newText="Adiós")[0] is False
    assert "Adiós" in tool("read_file", path="panel/index.html")[1]
    assert tool("edit_file", path="panel/index.html", oldText="no existe", newText="x")[0] is True
    assert tool("edit_file", path="panel/index.html", oldText="div", newText="section")[0] is True  # aparece 2 veces
    assert tool("edit_file", path="panel/index.html", oldText="div", newText="section", replaceAll=True)[0] is False

    assert tool("write_file", path="../fuera.txt", content="x")[0] is True
    assert tool("write_file", path=".git/config", content="x")[0] is True
    assert "index.html" in tool("list_directory", path="panel")[1]
    assert "index.html:1" in tool("search_text", query="section")[1]

    assert "panel/" in tool("git_status")[1] or "??" in tool("git_status")[1]
    assert tool("git_commit", message="prueba")[0] is False
    assert "prueba" in subprocess.run(["git", "log", "--oneline"], cwd=root, capture_output=True, text=True).stdout
    err, msg = tool("git_branch", name="feat")
    assert not err, msg
    assert tool("git_push")[0] is True  # sin token: error claro, sin colgarse
    assert tool("github_request", method="GET", path="/user")[0] is True
    proc.stdin.close()
    proc.wait(timeout=10)

print("test_repo_mcp: todo correcto")
