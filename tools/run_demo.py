#!/usr/bin/env python3
"""Run the dashboard and backend locally with isolated fictional demo data."""

import argparse
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-port", type=int, default=8001)
    parser.add_argument("--web-port", type=int, default=5173)
    args = parser.parse_args()
    if args.api_port == args.web_port or not all(1024 <= p <= 65535 for p in (args.api_port, args.web_port)):
        parser.error("Choose two different ports between 1024 and 65535.")

    python = ROOT / "backend/.venv/bin/python"
    npm = shutil.which("npm")
    if not python.is_file() or not (ROOT / "frontend/node_modules/.bin/vite").is_file() or not npm:
        parser.exit(1, "Install dependencies first:\n  cd backend && uv sync --frozen --extra test\n  cd ../frontend && npm ci\n")
    for port in (args.api_port, args.web_port):
        with socket.socket() as check:
            # Permit restarting after closed connections enter TIME_WAIT.
            check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                check.bind(("127.0.0.1", port))
            except OSError:
                parser.exit(1, f"Port {port} is unavailable. Choose --api-port and --web-port; existing services are left running.\n")

    runtime = ROOT / "runtime/software-demo"
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(runtime, 0o700)
    api = f"http://127.0.0.1:{args.api_port}"
    web = f"http://127.0.0.1:{args.web_port}"
    env = dict(os.environ)
    env.update({
        "CARELOOP_DATABASE_URL": f"sqlite:///{runtime / 'careloop.db'}",
        "CARELOOP_ALLOWED_ORIGINS": web,
        "CARELOOP_COOKIE_SECURE": "false",
        "CARELOOP_PROVIDER": "unconfigured",
        "CARELOOP_TESTING": "false",
        "CARELOOP_ADMIN_ENABLED": "false",
        "CARELOOP_DEVELOPMENT_SEED": "false",
        "CARELOOP_SCHEDULER_ENABLED": "true",
        "CARELOOP_API_TARGET": api,
        "VITE_DEMO_MODE": "true",
    })
    # Save the seed's one-time device credential privately; never print it here.
    seed_path = runtime / "seed-private.log"
    seed_fd = os.open(seed_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.fchmod(seed_fd, 0o600)
    with os.fdopen(seed_fd, "ab") as seed_log:
        subprocess.run([str(python), "-m", "app.seed"], cwd=ROOT / "backend",
                       env={**env, "CARELOOP_DEVELOPMENT_SEED": "true"},
                       stdout=seed_log, stderr=seed_log, check=True)

    children = []
    logs = []
    try:
        for name, command, cwd in (
            ("backend", [str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(args.api_port), "--no-access-log"], ROOT / "backend"),
            ("dashboard", [npm, "run", "dev", "--", "--port", str(args.web_port), "--strictPort"], ROOT / "frontend"),
        ):
            log = open(runtime / f"{name}.log", "wb")
            logs.append(log)
            children.append(subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=log, start_new_session=True))

        deadline = time.monotonic() + 30
        pending = {api + "/healthz", web}
        while pending:
            if any(child.poll() is not None for child in children):
                raise RuntimeError(f"A service stopped during startup. See logs in {runtime}.")
            if time.monotonic() > deadline:
                raise RuntimeError(f"Startup timed out. See logs in {runtime}.")
            for url in tuple(pending):
                try:
                    with urlopen(url, timeout=1) as response:
                        if response.status == 200:
                            pending.remove(url)
                except OSError:
                    pass
            time.sleep(0.2)

        print(f"CareLoop software demo: {web}", flush=True)
        print("Owner: owner@careloop.invalid / fictional-demo-only", flush=True)
        print("Caregiver: caregiver@careloop.invalid / fictional-caregiver-only", flush=True)
        print("Fictional local data. Voice providers are unconfigured; dashboard workflows are available.", flush=True)
        print("Press Ctrl+C to stop. Demo records are kept for the next run.", flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(0.5)
        raise RuntimeError(f"A service stopped. See logs in {runtime}.")
    finally:
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        for log in logs:
            log.close()


if __name__ == "__main__":
    def stop_requested(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_requested)
    try:
        main()
    except KeyboardInterrupt:
        print("\nCareLoop demo stopped. Saved records are unchanged.")
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
