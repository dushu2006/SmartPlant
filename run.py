#!/usr/bin/env python3
"""
SmartPlant — one-shot launcher.

  python3 run.py [--port 4000] [--skip-install] [--no-browser]

What it does:
  1. Checks prerequisites (Node.js >= 22, npm).
  2. First run only: creates `.env` from `.env.example` and installs backend
     dependencies (npm install).
  3. Syncs the frontend static assets into frontend/dist (served by the API).
  4. Starts the backend server (API + frontend on one port, default 4000) —
     or reuses an already-running instance.
  5. Opens the application in your default browser.

Press Ctrl+C to stop the server. Python 3 stdlib only — no pip installs.
"""

import argparse
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
DIST = FRONTEND / "dist"
ENV_FILE = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"

server_proc = None


def log(msg: str) -> None:
    print(f"[smartplant] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"[smartplant] ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def stop_server() -> None:
    global server_proc
    if server_proc is None or server_proc.poll() is not None:
        server_proc = None
        return
    log("stopping server…")
    try:
        # Kill the whole process group (npm + node child).
        if os.name == "posix":
            os.killpg(os.getpgid(server_proc.pid), signal.SIGTERM)
        else:
            server_proc.terminate()
        try:
            server_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                os.killpg(os.getpgid(server_proc.pid), signal.SIGKILL)
            else:
                server_proc.kill()
    except Exception as err:  # noqa: BLE001
        log(f"error while stopping server: {err}")
    server_proc = None


def handle_stop(_signum, _frame) -> None:
    log("shutting down…")
    stop_server()
    log("bye")
    sys.exit(0)


# ---------------------------------------------------------------- prerequisites
def check_prereqs() -> None:
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        die(
            "Node.js >= 22 and npm are required but not on PATH.\n"
            "  Install: https://nodejs.org/  (or: apt install nodejs npm)"
        )
    try:
        ver = subprocess.run(
            [node, "--version"], capture_output=True, text=True, check=True, timeout=15
        ).stdout.strip()
    except Exception:
        ver = "unknown"
    major = 0
    if ver.startswith("v"):
        try:
            major = int(ver[1:].split(".")[0])
        except ValueError:
            pass
    if major and major < 22:
        die(f"Node {ver} is too old — SmartPlant needs Node >= 22 (found {ver}).")
    log(f"prerequisites OK: {ver} (node), npm {npm}")


# ---------------------------------------------------------------- first run
def ensure_env() -> None:
    if ENV_FILE.exists():
        log(f".env found (edit it to add AI keys / settings): {ENV_FILE}")
        return
    if not ENV_EXAMPLE.exists():
        log("no .env.example found — skipping .env creation")
        return
    shutil.copyfile(ENV_EXAMPLE, ENV_FILE)
    log(f"created .env from .env.example — edit it to add your AI keys")


def ensure_backend_deps() -> None:
    node_modules = BACKEND / "node_modules"
    if node_modules.exists() and any(node_modules.iterdir()):
        log("backend dependencies already installed — skipping")
        return
    log("installing backend dependencies (first run, may take a minute)…")
    rc = subprocess.run([npm_cmd(), "install"], cwd=BACKEND).returncode
    if rc != 0:
        die(f"npm install failed (exit {rc}). Check the output above.")
    if not (BACKEND / "node_modules" / "express").exists():
        die("npm install finished but node_modules look incomplete — try again.")
    log("backend dependencies installed")


def sync_frontend() -> None:
    """No build step: the frontend is a dependency-free SPA. Copy everything
    under frontend/ (except dist/ itself) into dist/, which is what the
    backend serves at '/'. Only refresh changed files."""
    if not FRONTEND.exists():
        die("frontend/ directory is missing — cannot serve the application.")
    DIST.mkdir(exist_ok=True)
    changed = 0
    sources = [(FRONTEND, Path("."))]
    if (ROOT / "images").exists():
        # referenced by the frontend as /images/... → dist/images/...
        sources.append((ROOT / "images", Path("images")))
    for src_dir, prefix in sources:
        for entry in src_dir.iterdir():
            if entry.name == "dist":
                continue
            if entry.is_dir():
                for src in entry.rglob("*"):
                    if not src.is_file():
                        continue
                    dst = DIST / prefix / src.relative_to(src_dir)
                    if not dst.exists() or src.stat().st_mtime > dst.stat().st_mtime:
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(src, dst)
                        changed += 1
            else:
                dst = DIST / prefix / entry.name
                if not dst.exists() or entry.stat().st_mtime > dst.stat().st_mtime:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(entry, dst)
                    changed += 1
    if changed:
        log(f"frontend assets synced to frontend/dist ({changed} file(s))")
    else:
        log("frontend assets up to date")


# ---------------------------------------------------------------- server
def server_alive(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def start_server(port: int) -> None:
    global server_proc
    if server_alive(port):
        log(f"server already running on port {port} — reusing it")
        return
    env = dict(os.environ)
    env["PORT"] = str(port)
    log(f"starting SmartPlant server on http://localhost:{port} …")
    server_proc = subprocess.Popen(
        [npm_cmd(), "start"],
        cwd=BACKEND,
        env=env,
        start_new_session=os.name == "posix",
    )
    deadline = time.time() + 60
    while time.time() < deadline:
        if server_proc.poll() is not None:
            die(f"server exited early (code {server_proc.returncode}). Check backend logs.")
        if server_alive(port):
            log("server is up")
            return
        time.sleep(0.5)
    die(f"server did not become healthy within 60s on port {port}.")


def open_browser(port: int) -> None:
    url = f"http://localhost:{port}"
    log(f"opening {url} in your browser…")
    try:
        opened = webbrowser.open(url)
        if not opened:
            raise RuntimeError("webbrowser.open returned False")
    except Exception as err:
        log(f"could not auto-open the browser ({err}) — open {url} manually")


def npm_cmd() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


# ---------------------------------------------------------------- main
def main() -> int:
    parser = argparse.ArgumentParser(description="SmartPlant launcher")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "4000")))
    parser.add_argument("--skip-install", action="store_true", help="skip dependency installation")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser")
    args = parser.parse_args()

    log("SmartPlant launcher")
    log(f"platform: {platform.system()} {platform.release()} | python {platform.python_version()}")
    log(f"project root: {ROOT}")

    check_prereqs()
    if not args.skip_install:
        ensure_env()
        ensure_backend_deps()
    sync_frontend()
    start_server(args.port)
    if not args.no_browser:
        open_browser(args.port)

    log("SmartPlant is running. Press Ctrl+C to stop.")
    signal.signal(signal.SIGINT, handle_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_stop)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        handle_stop(signal.SIGINT, None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
