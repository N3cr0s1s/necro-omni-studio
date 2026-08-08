"""Project-relative path handling.

Every path the sidecar receives comes from the renderer, which means it is untrusted input
crossing a process boundary. The whole module exists to guarantee one property: a resolved
path is always inside the project root. Without that, an ``AssetPath`` of ``../../.ssh/id_rsa``
turns a media probe endpoint into an arbitrary file read.

The TypeScript side validates paths too, but this check is not redundant: the sidecar is a
separate HTTP server on localhost and must not depend on its only caller being well behaved.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath

# Folders the spec reserves inside a project.
PROJECT_FOLDERS = (
    "media",
    "generated",
    "masks",
    "effects",
    "generators",
    "notes",
    "renders",
    "cache",
)

CACHE_FOLDER = "cache"


class PathError(ValueError):
    """A supplied path is not a usable project-relative path."""


def normalize_relative(raw: str) -> PurePosixPath:
    """Validate a project-relative path and return it in POSIX form.

    Rejects absolute paths, drive letters, parent traversal and empty segments. Backslashes
    are folded to forward slashes so a project authored on Windows works unchanged, which the
    spec requires for folder portability.
    """
    if not raw or not raw.strip():
        raise PathError("path must not be empty")

    candidate = raw.replace("\\", "/").strip()
    if candidate.startswith("./"):
        candidate = candidate[2:]

    if candidate.startswith("/"):
        raise PathError(f"path must be project-relative: {raw!r}")
    # Windows drive letter, e.g. `C:/`.
    if len(candidate) >= 2 and candidate[1] == ":":
        raise PathError(f"path must be project-relative: {raw!r}")

    parts = candidate.split("/")
    if any(part == "" for part in parts):
        raise PathError(f"path must not contain empty segments: {raw!r}")
    if any(part == ".." for part in parts):
        raise PathError(f"path must not escape the project folder: {raw!r}")

    return PurePosixPath(candidate)


def resolve_in_project(root: Path, raw: str) -> Path:
    """Resolve a project-relative path to an absolute one inside ``root``.

    The containment check is performed *after* resolution, so a symlink pointing outside the
    project is caught as well. Validating only the textual form would miss that: a symlink at
    ``media/elsewhere`` has a perfectly innocent-looking relative path.
    """
    relative = normalize_relative(raw)
    root_resolved = root.resolve()
    target = (root_resolved / relative).resolve()

    if target != root_resolved and root_resolved not in target.parents:
        raise PathError(f"path escapes the project folder: {raw!r}")

    return target


def to_relative(root: Path, absolute: Path) -> str:
    """Express an absolute path relative to the project root, POSIX-style."""
    root_resolved = root.resolve()
    resolved = absolute.resolve()
    try:
        return resolved.relative_to(root_resolved).as_posix()
    except ValueError as error:
        raise PathError(f"{absolute} is not inside {root}") from error


def is_cache_path(relative: str) -> bool:
    """Whether a project-relative path lies inside the disposable cache folder."""
    return relative == CACHE_FOLDER or relative.startswith(f"{CACHE_FOLDER}/")


def ensure_project_layout(root: Path) -> None:
    """Create the reserved folders if they are missing.

    Idempotent: opening an existing project must not disturb it, and a project the user
    created by hand should still work. Directories are created rather than demanded because
    the spec defines a project as a folder, not as something only this app may produce.
    """
    root.mkdir(parents=True, exist_ok=True)
    for folder in PROJECT_FOLDERS:
        (root / folder).mkdir(exist_ok=True)
