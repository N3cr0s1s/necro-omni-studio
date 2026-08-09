"""Exiting when the editor that started us goes away.

The sidecar is stopped politely on `before-quit` and `window-all-closed`, which covers every ordinary
way an editor closes. It does not cover the editor being killed, crashing, or its machine losing
power on the way down — and in those cases the sidecar keeps running forever, holding its port, its
memory, and whatever the segmenter left in VRAM.

That is not a theoretical cost. A development session that killed the shell repeatedly left twenty-two
orphaned sidecars behind, and one of them had taken a port another tool wanted; the symptom was an
unrelated program failing to start with no useful message.

## Why stdin rather than a pid

Watching a parent pid needs a portable "is this process alive" check, and there is not a good one:
`os.kill(pid, 0)` is POSIX, and on Windows Python does not implement signal 0. Pid reuse makes it
wrong in principle too — a long-lived sidecar can outlive the pid space wrapping round.

An inherited pipe has neither problem. When the parent dies the operating system closes its end,
whatever killed it and whatever platform it was, and a blocking read here returns end-of-file. It
needs no dependency, no polling interval and no permissions.

## Why it is opt-in

A sidecar started from a terminal for debugging may have stdin connected to `/dev/null`, which reads
end-of-file immediately — so an unconditional watchdog would make the service impossible to run by
hand. The parent that wants this behaviour asks for it, and only the parent knows it has provided a
pipe to watch.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import BinaryIO, Callable


def watch_parent(
    stream: BinaryIO | None = None,
    on_orphaned: Callable[[], None] | None = None,
) -> threading.Thread:
    """Start a daemon thread that ends the process when `stream` reaches end-of-file.

    The thread is a daemon so it can never hold up an ordinary shutdown: if the sidecar is stopping
    for its own reasons, a thread blocked on a read that will never return must not keep it alive.

    `on_orphaned` is injected so this is testable without ending the test runner, and so a caller can
    choose a different way to stop — a future one may want to finish an in-flight encode first.
    """
    source = sys.stdin.buffer if stream is None else stream
    quit_ = _hard_exit if on_orphaned is None else on_orphaned

    thread = threading.Thread(
        target=_wait_for_eof,
        args=(source, quit_),
        name="parent-watch",
        daemon=True,
    )
    thread.start()
    return thread


def _wait_for_eof(stream: BinaryIO, on_orphaned: Callable[[], None]) -> None:
    try:
        while True:
            chunk = stream.read(1)
            if chunk == b"":
                break
            # Anything actually sent is ignored rather than treated as a command. This pipe exists to
            # be closed; giving it a second meaning would make an accidental write a control channel.
    except Exception:  # noqa: BLE001 - a broken pipe means the same thing as end-of-file
        pass

    on_orphaned()


def _hard_exit() -> None:
    """Leave immediately, without unwinding.

    `sys.exit` raises in *this* thread, which a daemon thread cannot use to stop the process, and a
    clean uvicorn shutdown would wait for connections that no longer have anyone at the other end.
    The parent is gone; there is nothing left to be polite to.
    """
    os._exit(0)
