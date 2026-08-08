"""Sidecar entry point.

Spawned by the Electron main process with the project root and a shared token. Port 0 by default
so the OS assigns a free port; the chosen port is printed as a single line of JSON on stdout, which
is how the parent learns where to connect. Hard-coding a port would collide with a second instance
and with whatever else the user is running.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
from pathlib import Path

import uvicorn

from .app import create_app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="nos-sidecar", description="Media service")
    parser.add_argument("--project-root", required=True, type=Path)
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Loopback only. Exposing this service on a routable interface would publish the "
        "user's filesystem, so a non-loopback value is rejected.",
    )
    parser.add_argument("--port", default=0, type=int, help="0 selects a free port")
    parser.add_argument(
        "--log-level",
        default="warning",
        choices=["critical", "error", "warning", "info", "debug"],
    )
    return parser.parse_args(argv)


def resolve_token() -> str:
    """Read the shared token from the environment.

    Passed by environment rather than as an argument because command lines are visible to every
    process on the machine via the process table, which would defeat the token entirely.
    """
    token = os.environ.get("NOS_SIDECAR_TOKEN")
    if not token:
        raise SystemExit("NOS_SIDECAR_TOKEN must be set")
    return token


def reserve_port(host: str, port: int) -> tuple[socket.socket, int]:
    """Bind a socket up front so the real port can be reported before serving starts.

    Letting uvicorn bind would mean the parent has to scrape a log line to learn the port, which is
    fragile across uvicorn versions. Passing an already-bound socket removes the guesswork and the
    race.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(128)
    return sock, sock.getsockname()[1]


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.host not in {"127.0.0.1", "::1", "localhost"}:
        raise SystemExit(f"refusing to bind to non-loopback host {args.host!r}")

    token = resolve_token()
    root = args.project_root.expanduser().resolve()

    sock, port = reserve_port(args.host, args.port)

    # The handshake line. Emitted before serving so the parent never polls a port that is not yet
    # bound, and flushed explicitly because stdout is a pipe here, not a terminal.
    print(json.dumps({"event": "listening", "host": args.host, "port": port}), flush=True)

    app = create_app(root, token)
    config = uvicorn.Config(app, log_level=args.log_level, access_log=False)
    server = uvicorn.Server(config)
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
