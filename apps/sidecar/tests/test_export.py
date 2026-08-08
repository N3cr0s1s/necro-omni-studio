"""Export encoding tests, against real ffmpeg.

The property that matters is end-to-end: raw RGBA frames in, a playable mp4 out, with the right
dimensions,
the right frame count, and the right pixels the right way up. None of that survives being mocked,
and the
vertical flip in particular is the kind of thing that only shows in a decoded pixel.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

WIDTH = 64
HEIGHT = 48


def rgba_frame(top: tuple[int, int, int], bottom: tuple[int, int, int]) -> bytes:
    """A frame whose top and bottom halves differ, so orientation is detectable."""
    rows = []
    for y in range(HEIGHT):
        colour = top if y < HEIGHT // 2 else bottom
        rows.append(bytes([*colour, 255]) * WIDTH)
    return b"".join(rows)


def probe(path: Path) -> dict:
    output = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return json.loads(output.stdout)


def decode_first_frame(path: Path) -> bytes:
    """Decode frame 0 back to raw RGBA, so the encoded pixels can be inspected."""
    output = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-v",
            "error",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    return output.stdout


def pixel_at(frame: bytes, x: int, y: int) -> tuple[int, int, int]:
    offset = (y * WIDTH + x) * 4
    return (frame[offset], frame[offset + 1], frame[offset + 2])


def start_export(client: TestClient, job_id: str = "job1", **overrides) -> dict:
    body = {
        "job_id": job_id,
        "output": "renders/out.mp4",
        "width": WIDTH,
        "height": HEIGHT,
        "frame_rate": "30",
        "codec": "h264",
        "crf": 18,
        "speed": "veryfast",
        "expected_frames": 10,
        **overrides,
    }
    return client.post("/export/start", json=body).json()


class TestEncodeLifecycle:
    def test_encodes_frames_into_a_playable_file(self, client: TestClient, project: Path) -> None:
        start_export(client)
        frames = b"".join(rgba_frame((255, 0, 0), (0, 0, 255)) for _ in range(10))
        client.post("/export/job1/frames", content=frames)
        status = client.post("/export/job1/finish").json()

        assert status["state"] == "complete"
        output = project / "renders" / "out.mp4"
        assert output.exists()

        streams = probe(output)["streams"]
        video = next(s for s in streams if s["codec_type"] == "video")
        assert video["width"] == WIDTH
        assert video["height"] == HEIGHT
        assert video["codec_name"] == "h264"
        # yuv420p is the only chroma layout every player handles.
        assert video["pix_fmt"] == "yuv420p"

    def test_writes_every_frame_supplied(self, client: TestClient, project: Path) -> None:
        start_export(client)
        client.post(
            "/export/job1/frames",
            content=b"".join(rgba_frame((10, 200, 10), (10, 200, 10)) for _ in range(10)),
        )
        client.post("/export/job1/finish")

        streams = probe(project / "renders" / "out.mp4")["streams"]
        video = next(s for s in streams if s["codec_type"] == "video")
        assert int(video.get("nb_frames", 0)) == 10

    def test_reports_frames_written_as_they_arrive(self, client: TestClient) -> None:
        start_export(client)
        client.post(
            "/export/job1/frames",
            content=b"".join(rgba_frame((1, 2, 3), (1, 2, 3)) for _ in range(4)),
        )
        status = client.get("/export/job1").json()
        assert status["frames_written"] == 4
        assert status["state"] == "running"
        client.post("/export/job1/cancel")

    def test_accepts_frames_split_across_chunk_boundaries(
        self, client: TestClient, project: Path
    ) -> None:
        # Chunk boundaries have nothing to do with frame boundaries when streaming over HTTP.
        start_export(client)
        payload = b"".join(rgba_frame((200, 100, 50), (50, 100, 200)) for _ in range(10))
        third = len(payload) // 3
        for chunk in (payload[:third], payload[third : third * 2], payload[third * 2 :]):
            client.post("/export/job1/frames", content=chunk)
        status = client.post("/export/job1/finish").json()

        assert status["state"] == "complete"
        assert status["frames_written"] == 10


class TestOrientation:
    def test_flips_the_webgl_framebuffer_to_image_orientation(
        self, client: TestClient, project: Path
    ) -> None:
        # WebGL's origin is bottom-left, every image format's is top-left. Without the flip the
        # export is upside down — a defect invisible in the preview and obvious only in the
        # delivered file.
        start_export(client)
        # In WebGL read-back order, the first row is the *bottom* of the picture. Supply red first.
        frames = b"".join(rgba_frame((255, 0, 0), (0, 0, 255)) for _ in range(6))
        client.post("/export/job1/frames", content=frames)
        client.post("/export/job1/finish")

        decoded = decode_first_frame(project / "renders" / "out.mp4")
        top = pixel_at(decoded, WIDTH // 2, 4)
        bottom = pixel_at(decoded, WIDTH // 2, HEIGHT - 5)

        # After the flip, the blue half supplied last must appear at the top of the image.
        assert bottom[0] > 150 and bottom[2] < 80, f"expected red at the bottom, got {bottom}"
        assert top[2] > 150 and top[0] < 80, f"expected blue at the top, got {top}"


class TestAudioMuxing:
    def test_muxes_an_audio_track(self, client: TestClient, project: Path) -> None:
        start_export(client, audio="media/tone.flac", audio_codec="aac")
        client.post(
            "/export/job1/frames",
            content=b"".join(rgba_frame((80, 80, 80), (80, 80, 80)) for _ in range(30)),
        )
        status = client.post("/export/job1/finish").json()

        assert status["state"] == "complete"
        streams = probe(project / "renders" / "out.mp4")["streams"]
        assert any(s["codec_type"] == "audio" for s in streams)

    def test_produces_video_only_when_no_audio_is_given(
        self, client: TestClient, project: Path
    ) -> None:
        start_export(client)
        client.post(
            "/export/job1/frames",
            content=b"".join(rgba_frame((0, 0, 0), (0, 0, 0)) for _ in range(5)),
        )
        client.post("/export/job1/finish")

        streams = probe(project / "renders" / "out.mp4")["streams"]
        assert not any(s["codec_type"] == "audio" for s in streams)


class TestCancellation:
    def test_removes_the_partial_file(self, client: TestClient, project: Path) -> None:
        # A truncated mp4 has no moov atom and will not play; leaving one in renders/ invites the
        # user to try, so it is deleted.
        start_export(client)
        client.post(
            "/export/job1/frames",
            content=b"".join(rgba_frame((1, 1, 1), (1, 1, 1)) for _ in range(3)),
        )
        status = client.post("/export/job1/cancel").json()

        assert status["state"] == "cancelled"
        assert not (project / "renders" / "out.mp4").exists()

    def test_rejects_frames_after_cancellation(self, client: TestClient) -> None:
        start_export(client)
        client.post("/export/job1/cancel")
        response = client.post("/export/job1/frames", content=rgba_frame((1, 1, 1), (1, 1, 1)))
        assert response.status_code == 409

    def test_cancelling_twice_is_harmless(self, client: TestClient) -> None:
        start_export(client)
        client.post("/export/job1/cancel")
        assert client.post("/export/job1/cancel").json()["state"] == "cancelled"


class TestValidation:
    def test_rejects_a_duplicate_job_id(self, client: TestClient) -> None:
        start_export(client)
        response = client.post(
            "/export/start",
            json={
                "job_id": "job1",
                "output": "renders/other.mp4",
                "width": WIDTH,
                "height": HEIGHT,
                "frame_rate": "30",
            },
        )
        assert response.status_code == 409
        client.post("/export/job1/cancel")

    def test_reports_an_unknown_job(self, client: TestClient) -> None:
        assert client.get("/export/nope").status_code == 404

    def test_refuses_an_output_outside_the_project(self, client: TestClient) -> None:
        response = client.post(
            "/export/start",
            json={
                "job_id": "escape",
                "output": "../../evil.mp4",
                "width": WIDTH,
                "height": HEIGHT,
                "frame_rate": "30",
            },
        )
        assert response.status_code == 400
        assert response.json()["kind"] == "invalid-path"

    def test_rejects_an_out_of_range_crf(self, client: TestClient) -> None:
        response = client.post(
            "/export/start",
            json={
                "job_id": "bad",
                "output": "renders/x.mp4",
                "width": WIDTH,
                "height": HEIGHT,
                "frame_rate": "30",
                "crf": 99,
            },
        )
        assert response.status_code == 422

    def test_requires_authentication(self, anonymous_client: TestClient) -> None:
        response = anonymous_client.post(
            "/export/start",
            json={
                "job_id": "x",
                "output": "renders/x.mp4",
                "width": 64,
                "height": 48,
                "frame_rate": "30",
            },
        )
        assert response.status_code == 401


class TestCodecs:
    def test_encodes_h265(self, client: TestClient, project: Path) -> None:
        start_export(client, codec="h265", crf=28)
        client.post(
            "/export/job1/frames",
            content=b"".join(rgba_frame((30, 60, 90), (90, 60, 30)) for _ in range(10)),
        )
        status = client.post("/export/job1/finish").json()

        assert status["state"] == "complete", status
        video = next(
            s
            for s in probe(project / "renders" / "out.mp4")["streams"]
            if s["codec_type"] == "video"
        )
        assert video["codec_name"] == "hevc"

    def test_honours_the_frame_rate(self, client: TestClient, project: Path) -> None:
        start_export(client, frame_rate="30000/1001")
        client.post(
            "/export/job1/frames",
            content=b"".join(rgba_frame((5, 5, 5), (5, 5, 5)) for _ in range(10)),
        )
        client.post("/export/job1/finish")

        video = next(
            s
            for s in probe(project / "renders" / "out.mp4")["streams"]
            if s["codec_type"] == "video"
        )
        # The exact rational must survive; a rounded 29.97 would drift against the audio.
        assert video["r_frame_rate"] == "30000/1001"
