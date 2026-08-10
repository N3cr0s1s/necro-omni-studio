"""Exiting when the editor that started us goes away.

The sidecar is stopped politely on every ordinary close. This covers the ones that are not
ordinary —
the shell killed, crashed, or gone with its machine — after which the sidecar would otherwise
keep its
port, its memory and whatever the segmenter left in VRAM, indefinitely.
"""

from __future__ import annotations

import io
import os
import threading

from nos_sidecar.parent_watch import watch_parent


class _Blocking(io.RawIOBase):
    """A stream that never returns, standing in for a parent that is still alive."""

    def __init__(self) -> None:
        self.released = threading.Event()

    def read(self, _size: int = -1) -> bytes:  # type: ignore[override]
        self.released.wait(timeout=5)
        return b""


def test_exits_when_the_pipe_closes() -> None:
    """End-of-file is the whole signal: the parent's end closed, so the parent is gone."""
    fired = threading.Event()
    watch_parent(io.BytesIO(b""), fired.set)
    assert fired.wait(timeout=5), "an already-closed pipe should be noticed immediately"


def test_stays_while_the_parent_holds_the_pipe_open() -> None:
    """A live parent must not be mistaken for a dead one; that would end a working session."""
    fired = threading.Event()
    stream = _Blocking()
    watch_parent(stream, fired.set)
    assert not fired.wait(timeout=0.3)
    stream.released.set()


def test_ignores_anything_written_down_the_pipe() -> None:
    """The pipe exists to be closed.

    Giving it a second meaning would turn an accidental write into a control channel, so bytes are
    read and discarded and only the end of the stream means anything.
    """
    fired = threading.Event()
    watch_parent(io.BytesIO(b"hello"), fired.set)
    assert fired.wait(timeout=5)


def test_treats_a_broken_pipe_as_a_dead_parent() -> None:
    """A read that raises means the same as one that ends: nobody is at the other end."""

    class _Broken(io.RawIOBase):
        def read(self, _size: int = -1) -> bytes:  # type: ignore[override]
            raise OSError("broken pipe")

    fired = threading.Event()
    watch_parent(_Broken(), fired.set)
    assert fired.wait(timeout=5)


def test_the_watcher_never_holds_up_a_shutdown() -> None:
    """A daemon thread, so a read that will never return cannot keep the process alive.

    Without this a sidecar stopping for its own reasons would hang on a parent still running.
    """
    stream = _Blocking()
    thread = watch_parent(stream, lambda: None)
    assert thread.daemon
    stream.released.set()


def test_reads_standard_input_by_default() -> None:
    """The default source is the inherited pipe, which is the only one the parent controls."""
    read_fd, write_fd = os.pipe()
    fired = threading.Event()

    with os.fdopen(read_fd, "rb") as reader:
        watch_parent(reader, fired.set)
        assert not fired.wait(timeout=0.2)
        os.close(write_fd)
        assert fired.wait(timeout=5), "closing the writing end should look like a dead parent"
