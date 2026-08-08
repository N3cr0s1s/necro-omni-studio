"""Path containment.

These tests carry more weight than their size suggests: every one of them is a file the sidecar must
refuse to read. The renderer validates paths too, but the sidecar is a localhost HTTP server and
cannot assume its caller is well behaved.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from nos_sidecar.paths import (
    PROJECT_FOLDERS,
    PathError,
    ensure_project_layout,
    is_cache_path,
    normalize_relative,
    resolve_in_project,
    to_relative,
)


class TestNormalizeRelative:
    def test_accepts_a_plain_relative_path(self) -> None:
        assert str(normalize_relative("media/interview_a.mp4")) == "media/interview_a.mp4"

    def test_folds_windows_separators(self) -> None:
        # A project authored on Windows must open unchanged on Linux.
        assert str(normalize_relative("media\\sub\\a.mp4")) == "media/sub/a.mp4"

    def test_strips_a_leading_current_directory(self) -> None:
        assert str(normalize_relative("./media/a.mp4")) == "media/a.mp4"

    @pytest.mark.parametrize(
        "raw",
        [
            "/etc/passwd",
            "/",
            "C:/Windows/System32",
            "c:/windows",
        ],
    )
    def test_rejects_absolute_paths(self, raw: str) -> None:
        with pytest.raises(PathError):
            normalize_relative(raw)

    @pytest.mark.parametrize(
        "raw",
        [
            "../secrets",
            "media/../../etc/passwd",
            "..",
            "media/..",
        ],
    )
    def test_rejects_parent_traversal(self, raw: str) -> None:
        with pytest.raises(PathError):
            normalize_relative(raw)

    @pytest.mark.parametrize("raw", ["", "   ", "media//a.mp4", "media/a.mp4/"])
    def test_rejects_empty_and_doubled_segments(self, raw: str) -> None:
        with pytest.raises(PathError):
            normalize_relative(raw)


class TestResolveInProject:
    def test_resolves_inside_the_root(self, tmp_path: Path) -> None:
        resolved = resolve_in_project(tmp_path, "media/a.mp4")
        assert resolved == (tmp_path / "media" / "a.mp4").resolve()

    def test_allows_the_root_itself(self, tmp_path: Path) -> None:
        assert resolve_in_project(tmp_path, "project.json").parent == tmp_path.resolve()

    def test_rejects_traversal(self, tmp_path: Path) -> None:
        with pytest.raises(PathError):
            resolve_in_project(tmp_path, "../outside.mp4")

    @pytest.mark.skipif(os.name == "nt", reason="symlink creation needs privileges on Windows")
    def test_rejects_a_symlink_escaping_the_project(self, tmp_path: Path) -> None:
        # The case textual validation alone would miss: `media/escape` looks perfectly innocent.
        root = tmp_path / "project"
        (root / "media").mkdir(parents=True)
        outside = tmp_path / "outside"
        outside.mkdir()
        secret = outside / "secret.txt"
        secret.write_text("private", encoding="utf-8")

        (root / "media" / "escape").symlink_to(secret)

        with pytest.raises(PathError):
            resolve_in_project(root, "media/escape")

    @pytest.mark.skipif(os.name == "nt", reason="symlink creation needs privileges on Windows")
    def test_allows_a_symlink_that_stays_inside(self, tmp_path: Path) -> None:
        root = tmp_path / "project"
        (root / "media").mkdir(parents=True)
        target = root / "media" / "real.mp4"
        target.write_bytes(b"data")
        (root / "media" / "alias.mp4").symlink_to(target)

        assert resolve_in_project(root, "media/alias.mp4") == target.resolve()

    def test_rejects_a_sibling_directory_with_a_shared_prefix(self, tmp_path: Path) -> None:
        # `/tmp/x/project-evil` must not be reachable from root `/tmp/x/project`.
        root = tmp_path / "project"
        root.mkdir()
        (tmp_path / "project-evil").mkdir()
        with pytest.raises(PathError):
            resolve_in_project(root, "../project-evil/file.txt")


class TestToRelative:
    def test_round_trips(self, tmp_path: Path) -> None:
        absolute = resolve_in_project(tmp_path, "media/a.mp4")
        assert to_relative(tmp_path, absolute) == "media/a.mp4"

    def test_rejects_a_path_outside_the_root(self, tmp_path: Path) -> None:
        with pytest.raises(PathError):
            to_relative(tmp_path / "project", tmp_path / "elsewhere" / "a.mp4")


class TestCachePaths:
    def test_recognizes_cache_contents(self) -> None:
        assert is_cache_path("cache")
        assert is_cache_path("cache/proxy_x.mp4")

    def test_does_not_match_a_similarly_named_folder(self) -> None:
        assert not is_cache_path("cached_ideas/a.md")


class TestEnsureProjectLayout:
    def test_creates_every_reserved_folder(self, tmp_path: Path) -> None:
        root = tmp_path / "new-project"
        ensure_project_layout(root)
        for folder in PROJECT_FOLDERS:
            assert (root / folder).is_dir()

    def test_is_idempotent_and_leaves_existing_content_alone(self, tmp_path: Path) -> None:
        root = tmp_path / "project"
        ensure_project_layout(root)
        marker = root / "media" / "keep.txt"
        marker.write_text("keep", encoding="utf-8")

        ensure_project_layout(root)

        assert marker.read_text(encoding="utf-8") == "keep"
