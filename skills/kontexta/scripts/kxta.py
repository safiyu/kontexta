#!/usr/bin/env python3
"""Stdio MCP client for the Kontexta (kxta) server, via a persistent per-cwd daemon."""
import hashlib
import hmac
import json
import os
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time

IS_WINDOWS = os.name == "nt"
if IS_WINDOWS:
    import msvcrt
else:
    import fcntl

# KXTA_SERVER: a .js entrypoint (run with node) or a full command line; defaults to the published CLI.
SERVER = os.environ.get("KXTA_SERVER", "npx -y --package=kontexta@latest kontexta mcp")
IDLE_SECONDS = int(os.environ.get("KXTA_IDLE_SECONDS", "1800"))
RUN_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.cache"), "kxta")


def server_argv():
    path = os.path.abspath(os.path.expanduser(SERVER))
    if path.endswith((".js", ".mjs")) and os.path.isfile(path):
        return ["node", path]
    if IS_WINDOWS:
        # Non-POSIX split keeps backslashes in paths but leaves the quotes on, so strip them.
        return [a[1:-1] if len(a) > 1 and a[0] == a[-1] == '"' else a for a in shlex.split(SERVER, posix=False)]
    return shlex.split(SERVER)


def spawnable(argv):
    # Windows can't exec npx.cmd-style shims directly; resolve via PATH/PATHEXT and route through cmd.
    exe = shutil.which(argv[0]) or argv[0]
    if IS_WINDOWS and exe.lower().endswith((".cmd", ".bat")):
        return ["cmd.exe", "/c", exe, *argv[1:]]
    return [exe, *argv[1:]]


def state_path(cwd):
    key = os.path.normcase(os.path.abspath(cwd))
    return os.path.join(RUN_DIR, hashlib.sha1(key.encode()).hexdigest()[:12] + ".json")


class FileLock:
    def __init__(self, path):
        self.f = open(path, "a+")

    def __enter__(self):
        if IS_WINDOWS:
            while True:
                try:
                    self.f.seek(0)
                    msvcrt.locking(self.f.fileno(), msvcrt.LK_LOCK, 1)
                    return self
                except OSError:
                    time.sleep(0.1)
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        try:
            if IS_WINDOWS:
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(self.f, fcntl.LOCK_UN)
        finally:
            self.f.close()


def write_line(stream, obj):
    stream.write((json.dumps(obj) + "\n").encode("utf-8"))
    stream.flush()


class McpClient:
    def __init__(self, cwd):
        env = dict(os.environ)
        env.setdefault("KONTEXTA_AGENT", "claude-code")
        argv = json.loads(env.pop("KXTA_SERVER_ARGV")) if "KXTA_SERVER_ARGV" in env else server_argv()
        self.proc = subprocess.Popen(
            spawnable(argv),
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0,
        )
        self.next_id = 0
        self.lock = threading.Lock()
        self.init = self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "kxta-skill", "version": "2.0"},
        })
        write_line(self.proc.stdin, {"jsonrpc": "2.0", "method": "notifications/initialized"})

    def request(self, method, params):
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            write_line(self.proc.stdin, {"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            for line in self.proc.stdout:
                try:
                    msg = json.loads(line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                # Server-initiated requests (ping, roots/list) must be answered or the server stalls.
                if "method" in msg and "id" in msg:
                    if msg["method"] == "ping":
                        write_line(self.proc.stdin, {"jsonrpc": "2.0", "id": msg["id"], "result": {}})
                    else:
                        write_line(self.proc.stdin, {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "unsupported"}})
                    continue
                if msg.get("id") != rid:
                    continue
                if "error" in msg:
                    raise RuntimeError(f"MCP error {msg['error'].get('code')}: {msg['error'].get('message')}")
                return msg["result"]
            raise RuntimeError("kxta server exited without responding")

    def alive(self):
        return self.proc.poll() is None

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def dispatch(client, req):
    op = req["op"]
    if op == "context":
        return {"text": client.init.get("instructions", "")}
    if op == "tools":
        return {"tools": client.request("tools/list", {})["tools"]}
    if op == "call":
        return {"result": client.request("tools/call", {"name": req["tool"], "arguments": req.get("args") or {}})}
    raise RuntimeError(f"unknown op: {op}")


def serve(cwd):
    path = state_path(cwd)
    client = McpClient(cwd)
    token = secrets.token_hex(16)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(16)
    srv.settimeout(0.5)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"port": srv.getsockname()[1], "token": token, "pid": os.getpid()}, f)
    if not IS_WINDOWS:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    last = [time.time()]
    stop = threading.Event()

    def handle(conn):
        with conn, conn.makefile("rwb") as f:
            for line in f:
                last[0] = time.time()
                try:
                    req = json.loads(line.decode("utf-8"))
                    if not hmac.compare_digest(str(req.get("token", "")), token):
                        resp = {"ok": False, "error": "bad token"}
                    elif req.get("op") == "stop":
                        stop.set()
                        resp = {"ok": True}
                    else:
                        resp = {"ok": True, **dispatch(client, req)}
                except Exception as e:
                    resp = {"ok": False, "error": str(e)}
                write_line(f, resp)
                last[0] = time.time()

    try:
        while not stop.is_set() and client.alive() and time.time() - last[0] < IDLE_SECONDS:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            conn.settimeout(None)
            threading.Thread(target=handle, args=(conn,), daemon=True).start()
    finally:
        srv.close()
        try:
            os.remove(path)
        except OSError:
            pass
        client.close()


def connect(cwd):
    with open(state_path(cwd)) as f:
        state = json.load(f)
    s = socket.create_connection(("127.0.0.1", state["port"]), timeout=5)
    s.settimeout(None)
    return s, state["token"]


def spawn_daemon(cwd):
    kwargs = {}
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "_serve", cwd],
        env={**os.environ, "KXTA_SERVER_ARGV": json.dumps(server_argv())},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **kwargs,
    )


def ensure_daemon(cwd):
    try:
        return connect(cwd)
    except (OSError, ValueError):
        pass
    os.makedirs(RUN_DIR, exist_ok=True)
    # Serialize spawns so parallel callers don't start duplicate daemons.
    with FileLock(state_path(cwd) + ".lock"):
        try:
            return connect(cwd)
        except (OSError, ValueError):
            try:
                os.remove(state_path(cwd))
            except OSError:
                pass
        daemon = spawn_daemon(cwd)
        # First npx run may download the package.
        deadline = time.time() + 120
        while time.time() < deadline and daemon.poll() is None:
            try:
                return connect(cwd)
            except (OSError, ValueError):
                time.sleep(0.1)
    raise RuntimeError(f"kxta server failed to start: {' '.join(server_argv())} (check Node 22+ or set KXTA_SERVER)")


class Session:
    def __init__(self, cwd):
        self.sock, self.token = ensure_daemon(cwd)
        self.f = self.sock.makefile("rwb")

    def ask(self, req):
        write_line(self.f, {**req, "token": self.token})
        line = self.f.readline()
        if not line:
            raise RuntimeError("kxta daemon closed the connection")
        resp = json.loads(line.decode("utf-8"))
        if not resp.get("ok"):
            raise RuntimeError(resp.get("error"))
        return resp


def result_text(result):
    out = []
    for item in result.get("content", []):
        out.append(item["text"] if item.get("type") == "text" else json.dumps(item))
    return "\n".join(out)


def main():
    # Windows consoles default to a legacy code page; kxta output contains emoji and non-ASCII text.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if args and args[0] == "_serve":
        serve(args[1])
        return
    if not args or args[0] in ("-h", "--help"):
        print("usage: kxta.py context | list | rules | schema <tool> | call <tool> [json-args | -] | batch | stop")
        return
    cwd = os.environ.get("KXTA_CWD", os.getcwd())
    cmd = args[0]
    if cmd == "stop":
        try:
            sock, token = connect(cwd)
        except (OSError, ValueError):
            print("no daemon running")
            return
        with sock, sock.makefile("rwb") as f:
            write_line(f, {"op": "stop", "token": token})
            f.readline()
        deadline = time.time() + 10
        while os.path.exists(state_path(cwd)) and time.time() < deadline:
            time.sleep(0.1)
        print("stopped")
        return
    try:
        sess = Session(cwd)
        if cmd == "context":
            print(sess.ask({"op": "context"})["text"])
        elif cmd == "list":
            for t in sess.ask({"op": "tools"})["tools"]:
                desc = " ".join((t.get("description") or "").split())
                print(f"{t['name']}: {desc[:140]}")
        elif cmd == "rules":
            # Emit a minimal markdown snippet to paste or redirect into CLAUDE.md so the agent
            # knows how to call every kxta tool through this bridge. Lighter than the full
            # admin_onboard_agent block (which assumes native mcp__kxta__* tool names).
            script = os.path.abspath(__file__)
            home = os.path.expanduser("~")
            display = "~" + script[len(home):] if script.startswith(home + os.sep) else script
            print("## kxta tools (via skill bridge)")
            print()
            print("To call any tool below, run:")
            print(f"`python3 {display} call <tool> '<json-args>'`")
            print()
            print(f"Inspect inputs with `python3 {display} schema <tool>`.")
            print()
            print("Tools:")
            for t in sess.ask({"op": "tools"})["tools"]:
                desc = " ".join((t.get("description") or "").split())
                print(f"- `{t['name']}` · {desc[:120]}")
        elif cmd == "schema":
            tools = {t["name"]: t for t in sess.ask({"op": "tools"})["tools"]}
            tool = tools.get(args[1]) if len(args) > 1 else None
            if not tool:
                sys.exit(f"unknown tool: {args[1] if len(args) > 1 else ''}")
            print(json.dumps(tool, indent=2))
        elif cmd == "call":
            if len(args) < 2:
                sys.exit("call needs a tool name")
            raw = args[2] if len(args) > 2 else "{}"
            if raw == "-":
                raw = sys.stdin.read()
            result = sess.ask({"op": "call", "tool": args[1], "args": json.loads(raw)})["result"]
            print(result_text(result))
            if result.get("isError"):
                sys.exit(1)
        elif cmd == "batch":
            # stdin: one {"tool": ..., "args": {...}} per line; stdout: one {"tool", "isError", "text"} per line
            failed = False
            for line in sys.stdin:
                if not line.strip():
                    continue
                item = json.loads(line)
                try:
                    result = sess.ask({"op": "call", "tool": item["tool"], "args": item.get("args")})["result"]
                    out = {"tool": item["tool"], "isError": bool(result.get("isError")), "text": result_text(result)}
                except RuntimeError as e:
                    out = {"tool": item["tool"], "isError": True, "text": str(e)}
                failed = failed or out["isError"]
                print(json.dumps(out), flush=True)
            if failed:
                sys.exit(1)
        else:
            sys.exit(f"unknown command: {cmd}")
    except RuntimeError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
