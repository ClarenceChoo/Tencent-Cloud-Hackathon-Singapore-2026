#!/usr/bin/env python3
"""Run the backend suite against an isolated disposable PostgreSQL cluster."""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = REPO_ROOT / "runtime"
BACKEND_ROOT = REPO_ROOT / "backend"


def executable(name: str, bin_dir: Path | None) -> str:
    candidate = bin_dir / name if bin_dir else None
    if candidate and candidate.is_file():
        return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    homebrew = Path("/opt/homebrew/bin") / name
    if homebrew.is_file():
        return str(homebrew)
    raise RuntimeError("PostgreSQL executable not found: %s" % name)


def unused_high_port() -> int:
    for _ in range(100):
        candidate = 49152 + secrets.randbelow(65535 - 49152)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", candidate))
            except OSError:
                continue
            return candidate
    raise RuntimeError("Could not reserve an unused high loopback port")


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=REPO_ROOT, env=env, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, default=None, help="directory containing PostgreSQL binaries")
    parser.add_argument("pytest_args", nargs=argparse.REMAINDER, help="arguments passed to pytest after --")
    args = parser.parse_args()
    pytest_args = args.pytest_args[1:] if args.pytest_args[:1] == ["--"] else args.pytest_args

    initdb = executable("initdb", args.pg_bin)
    pg_ctl = executable("pg_ctl", args.pg_bin)
    psql = executable("psql", args.pg_bin)
    python = BACKEND_ROOT / ".venv" / "bin" / "python"
    if not python.is_file():
        raise RuntimeError("backend/.venv is missing; run `uv sync --extra test` in backend first")

    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    port = unused_high_port()
    admin_user = "careloop_test_admin"
    password = secrets.token_urlsafe(32)
    database = "careloop_test_%s" % secrets.token_hex(8)
    start_attempted = False
    result = 1

    with tempfile.TemporaryDirectory(prefix="postgres-test-", dir=RUNTIME_ROOT) as temporary:
        cluster = Path(temporary) / "data"
        log_path = Path(temporary) / "postgres.log"
        password_path = Path(temporary) / "pwfile"
        password_path.write_text(password + "\n", encoding="utf-8")
        password_path.chmod(0o600)
        try:
            start_attempted = True
            run([
                initdb,
                "-D", str(cluster),
                "--username", admin_user,
                "--pwfile", str(password_path),
                "--auth-host=scram-sha-256",
                "--auth-local=trust",
                "--encoding=UTF8",
                "--no-locale",
            ])
            run([
                pg_ctl,
                "-D", str(cluster),
                "-l", str(log_path),
                "-o", "-c listen_addresses=127.0.0.1 -p %d -c unix_socket_directories=''" % port,
                "-w",
                "start",
            ])
            postgres_env = dict(os.environ, PGPASSWORD=password)
            run([
                psql,
                "-h", "127.0.0.1",
                "-p", str(port),
                "-U", admin_user,
                "-d", "postgres",
                "-v", "ON_ERROR_STOP=1",
                "-c", 'CREATE DATABASE "%s"' % database,
            ], env=postgres_env)
            test_env = dict(os.environ)
            test_env["CARELOOP_TEST_DATABASE_URL"] = "postgresql+psycopg://%s:%s@127.0.0.1:%d/%s" % (
                admin_user,
                quote(password, safe=""),
                port,
                database,
            )
            completed = subprocess.run(
                [str(python), "-m", "pytest", *pytest_args],
                cwd=BACKEND_ROOT,
                env=test_env,
                check=False,
            )
            result = completed.returncode
        except Exception:
            if log_path.is_file():
                tail = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-80:]
                print("\nPostgreSQL log tail:\n%s" % "\n".join(tail), file=sys.stderr)
            raise
        finally:
            if start_attempted:
                subprocess.run([pg_ctl, "-D", str(cluster), "-m", "fast", "-w", "stop"], cwd=REPO_ROOT, check=False)

    return result


if __name__ == "__main__":
    raise SystemExit(main())
