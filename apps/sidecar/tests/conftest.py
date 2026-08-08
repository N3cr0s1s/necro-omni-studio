"""Shared fixtures.

Real media is synthesized with ffmpeg rather than committed as binary fixtures. The sidecar's whole
job is talking to ffmpeg, so mocking it would test the mock; and generated sources let a test state
exactly what it depends on — a portrait aspect, a rotation flag, an audio-only container.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nos_sidecar.app import create_app
from nos_sidecar.paths import ensure_project_layout

TOKEN = "test-token"

# Amplitude of the synthesized test tone, in normalized float units. Asserted against by the
# waveform peak tests, so it lives here rather than being repeated as a literal.
TONE_AMPLITUDE = 0.9


def ffmpeg_generate(args: list[str]) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-y", *args],
        check=True,
        capture_output=True,
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """An initialized project folder with a small set of real media."""
    root = tmp_path / "project"
    ensure_project_layout(root)

    # Landscape with audio: the common case, and the one that yields two linked clips on import.
    ffmpeg_generate(
        [
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x180:rate=30:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(root / "media" / "landscape.mp4"),
        ]
    )
    # Portrait, to prove the proxy scaler constrains the short edge rather than the long one.
    ffmpeg_generate(
        [
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=180x320:rate=30:duration=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(root / "media" / "portrait.mp4"),
        ]
    )
    # Audio only, lossless — the format the spec requires generators to emit.
    #
    # `aevalsrc` with an explicit coefficient rather than the `sine` filter: sine defaults to
    # amplitude 0.125, so a test asserting peak accuracy against it would be asserting a magic
    # number. Here the expected amplitude is stated in the source and the peak reduction can be
    # checked against it directly.
    ffmpeg_generate(
        [
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc='{TONE_AMPLITUDE}*sin(2*PI*220*t)':d=2",
            "-c:a",
            "flac",
            str(root / "media" / "tone.flac"),
        ]
    )
    # A still image.
    ffmpeg_generate(
        [
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x64:duration=1",
            "-frames:v",
            "1",
            str(root / "media" / "still.png"),
        ]
    )
    (root / "notes" / "treatment.md").write_text("# Treatment\n", encoding="utf-8")
    return root


@pytest.fixture
def client(project: Path):
    """Authenticated test client. The app is exercised through HTTP, headers and all."""
    app = create_app(project, TOKEN)
    with TestClient(app) as test_client:
        test_client.headers.update({"X-Nos-Token": TOKEN})
        yield test_client


@pytest.fixture
def anonymous_client(project: Path):
    """Client with no token, for authentication tests."""
    app = create_app(project, TOKEN)
    with TestClient(app) as test_client:
        yield test_client
