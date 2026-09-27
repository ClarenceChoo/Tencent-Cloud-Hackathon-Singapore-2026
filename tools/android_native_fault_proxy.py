#!/usr/bin/env python3
"""Loopback-only TLS fault proxy for the existing fictional native fixture.

The proxy never logs headers, credentials, transcripts or audio. It forwards
only phone/device API paths to the fixture's verified TLS origin. A private
fault-mode.json controls disconnects after acceptance, never production code.
"""
import argparse
from datetime import datetime, timezone
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sqlite3
import ssl
import threading
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 2 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8444)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.is_relative_to(ROOT / "runtime") or not (directory / "fixture.db").is_file():
        raise SystemExit("Use an existing fictional runtime native fixture.")
    metadata = json.loads((directory / "fixture.json").read_text())
    origin = urlsplit(metadata["origin"])
    if origin.scheme != "https" or origin.hostname != "127.0.0.1" or not origin.port:
        raise SystemExit("Only the fixture's loopback TLS origin is permitted.")
    if not 1024 <= args.port <= 65535 or args.port == origin.port:
        raise SystemExit("Choose a separate unprivileged loopback port.")
    with sqlite3.connect(f"file:{directory / 'fixture.db'}?mode=ro", uri=True) as db:
        if not db.execute("SELECT 1 FROM users WHERE email='owner@native.invalid' AND role='owner'").fetchone():
            raise SystemExit("Fictional native owner marker is missing.")
    upstream_tls = ssl.create_default_context(cafile=str(directory / "tls/ca.pem"))
    local_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    local_tls.load_cert_chain(directory / "tls/server.pem", directory / "tls/server.key")
    lock = threading.Lock()
    mode_file = directory / "fault-mode.json"

    def mode():
        return json.loads(mode_file.read_text()) if mode_file.is_file() else {}

    def event(kind, **fields):
        with (directory / "fault-events.jsonl").open("a") as out:
            out.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "kind": kind, **fields}) + "\n")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def disconnect(self):
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()

        def body(self):
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                chunks, size = [], 0
                while True:
                    length = int(self.rfile.readline(100).split(b";", 1)[0], 16)
                    if not length:
                        while self.rfile.readline(8192) not in (b"\r\n", b"\n", b""):
                            pass
                        return b"".join(chunks)
                    size += length
                    if size > LIMIT:
                        raise ValueError("Fixture upload exceeds the phone limit")
                    chunk = self.rfile.read(length)
                    if len(chunk) != length or self.rfile.read(2) != b"\r\n":
                        raise ValueError("Incomplete chunk")
                    chunks.append(chunk)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= LIMIT:
                raise ValueError("Fixture request size is invalid")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("Incomplete request")
            return body

        def proxy(self):
            self.connection.settimeout(35)
            if not self.path.startswith(("/v1/phone/", "/v1/device/")):
                self.send_error(404)
                return
            with lock:
                if mode().get("offline"):
                    event("offline_connection_closed")
                    self.disconnect()
                    return
            body = self.body()
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in {"host", "connection", "transfer-encoding", "content-length"}}
            headers.update(Host=origin.netloc, Connection="close", **{"Content-Length": str(len(body))})
            upstream = http.client.HTTPSConnection(origin.hostname, origin.port, context=upstream_tls, timeout=30)
            try:
                upstream.request(self.command, self.path, body=body, headers=headers)
                response = upstream.getresponse()
                data = response.read(8 * 1024 * 1024 + 1)
                if len(data) > 8 * 1024 * 1024:
                    raise ValueError("Fixture response exceeds limit")
                with lock:
                    current = mode()
                    if self.command == "POST" and self.path == "/v1/phone/turns" and response.status == 202 and current.get("next_receipt_fault"):
                        fault = current["next_receipt_fault"]
                        if fault not in {"disconnect", "503"}:
                            raise ValueError("Unsupported fixture fault")
                        update = {"offline": True}
                        temporary = directory / "fault-mode.gateway.tmp"
                        temporary.write_text(json.dumps(update))
                        temporary.chmod(0o600)
                        temporary.replace(mode_file)
                        event("accepted_receipt_interrupted", fault=fault,
                              turn_id=json.loads(data)["turn_id"], upstream_status=202)
                        if fault == "disconnect":
                            self.disconnect()
                            return
                        error = b'{"detail":"Local test gateway interrupted the upload receipt."}'
                        self.send_response(503)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(error)))
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.wfile.write(error)
                        self.close_connection = True
                        return
                    if self.path.startswith("/v1/phone/turn-receipts/"):
                        event("receipt_lookup", upstream_status=response.status,
                              **({"turn_id": json.loads(data)["turn_id"]} if response.status == 200 else {}))
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in {"connection", "transfer-encoding", "content-length", "server", "date"}:
                        self.send_header(key, value)
                self.send_header("Content-Length", response.getheader("Content-Length", "0") if self.command == "HEAD" else str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)
                self.close_connection = True
            finally:
                upstream.close()

        do_GET = do_POST = do_PUT = do_HEAD = proxy

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, _request, _address):
            # Expected disconnects must not dump request state into logs.
            with lock:
                event("proxy_connection_ended")

    server = Server(("127.0.0.1", args.port), Handler)
    server.socket = local_tls.wrap_socket(server.socket, server_side=True)
    print(f"Fictional native TLS fault proxy ready on 127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
