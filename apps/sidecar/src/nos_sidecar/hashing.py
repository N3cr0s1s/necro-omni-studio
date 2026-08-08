"""Content hashing for cache identity.

The spec fixes asset identity as the project-relative path and cache identity as the content
hash. This module produces the latter.

## Why a full hash, and why it is still fast

Sampling (size plus a few chunks) is tempting for multi-gigabyte video, but it is wrong for the
job: the whole point of a content hash is that re-encoding a file in place, or restoring an
older version over it, invalidates the derived artifacts. A sampled hash misses exactly those
cases, and the symptom — a proxy that no longer matches its source — is close to impossible to
diagnose from a bug report.

So the hash is complete, and the cost is paid once: results are memoized against
``(size, mtime_ns)`` and persisted under ``cache/``, so reopening a project rehashes nothing.
BLAKE2b at a 16-byte digest is faster than SHA-256 and far wider than needed for collision
resistance at project scale.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

# 1 MiB: large enough that syscall overhead disappears, small enough to stay cache-friendly.
CHUNK_SIZE = 1024 * 1024

# 16 bytes -> 32 hex characters. Cache keys truncate this further for readability.
DIGEST_BYTES = 16

HASH_INDEX_FILE = "cache/hash-index.json"


@dataclass(frozen=True, slots=True)
class FileIdentity:
    """Cheap identity used to decide whether a cached hash is still valid."""

    size: int
    mtime_ns: int

    @staticmethod
    def of(path: Path) -> FileIdentity:
        stat = path.stat()
        return FileIdentity(size=stat.st_size, mtime_ns=stat.st_mtime_ns)

    def as_key(self) -> str:
        return f"{self.size}:{self.mtime_ns}"


def hash_bytes(payload: bytes) -> str:
    """Hash an in-memory payload. Used for generated text and small assets."""
    return hashlib.blake2b(payload, digest_size=DIGEST_BYTES).hexdigest()


def hash_file(path: Path) -> str:
    """Stream a file through BLAKE2b and return the hex digest."""
    digest = hashlib.blake2b(digest_size=DIGEST_BYTES)
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


class HashCache:
    """Memoizes content hashes across sessions.

    Keyed by relative path *and* ``(size, mtime_ns)``. Including the stat data is what makes
    the cache safe: a file replaced at the same path gets a different identity and is rehashed,
    so a stale hash can never be served. Keying by path alone would defeat the purpose.

    The persisted index is a convenience, never a source of truth. A missing, unreadable or
    corrupt index costs one rehash — it must never prevent a project from opening, so every
    read is best-effort.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        self._index_path = root / HASH_INDEX_FILE
        self._entries: dict[str, dict[str, str]] = {}
        self._dirty = False
        self._load()

    def _load(self) -> None:
        try:
            raw = self._index_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            # A truncated index from a hard kill mid-write. Discard and move on.
            return
        if not isinstance(parsed, dict):
            return
        for relative, entry in parsed.items():
            if (
                isinstance(relative, str)
                and isinstance(entry, dict)
                and isinstance(entry.get("identity"), str)
                and isinstance(entry.get("hash"), str)
            ):
                self._entries[relative] = {
                    "identity": entry["identity"],
                    "hash": entry["hash"],
                }

    def get(self, relative: str, path: Path) -> str:
        """Return the content hash, computing it only if the file changed."""
        identity = FileIdentity.of(path).as_key()
        cached = self._entries.get(relative)
        if cached is not None and cached["identity"] == identity:
            return cached["hash"]

        digest = hash_file(path)
        self._entries[relative] = {"identity": identity, "hash": digest}
        self._dirty = True
        return digest

    def forget(self, relative: str) -> None:
        if self._entries.pop(relative, None) is not None:
            self._dirty = True

    def flush(self) -> None:
        """Persist the index atomically.

        Written to a temporary sibling and renamed, so a crash mid-write leaves the previous
        index intact rather than a truncated file. Failure is swallowed: an unwritable cache
        directory must not break importing.
        """
        if not self._dirty:
            return
        try:
            self._index_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._index_path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(self._entries, indent=0), encoding="utf-8")
            temporary.replace(self._index_path)
            self._dirty = False
        except OSError:
            return
