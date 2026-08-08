"""The segmentation endpoints.

Exercised through HTTP, headers and all, with a scripted engine swapped in — the same approach the
export tests take. What is under test is the wire contract: authentication, validation responses,
the polling cursor, and that path containment still holds when the renderer names a cache folder.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nos_sidecar.rle import encode_rle
from nos_sidecar.segmentation import Capabilities, MaskFrame, SegmentRequest, SegmentState


class ScriptedEngine:
    """Produces a fixed number of two-by-two masks."""

    name = "scripted"

    def __init__(self, frames: int = 3, *, available: bool = True, delay: float = 0) -> None:
        self._frames = frames
        self._available = available
        self._delay = delay

    def capabilities(self) -> Capabilities:
        return Capabilities(
            available=self._available,
            propagates=True,
            detail="" if self._available else "the `sam2` package is not installed",
            model="scripted",
        )

    async def run(self, request: SegmentRequest) -> AsyncIterator[MaskFrame]:
        import asyncio

        for index in range(self._frames):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield MaskFrame(
                frame=request.start_frame + index,
                width=2,
                height=2,
                counts=tuple(encode_rle([1, 0, 0, 1], 2, 2)),
            )


def use_engine(client: TestClient, engine: ScriptedEngine) -> None:
    client.app.state.segmenter.register_engine(engine)  # type: ignore[attr-defined]


def start(client: TestClient, **overrides: object) -> dict:
    body = {
        "job_id": "j1",
        "source": "media/landscape.mp4",
        "start_frame": 0,
        "end_frame": 3,
        "points": [{"frame": 0, "x": 0.5, "y": 0.5, "include": True}],
        "cache_folder": "masks/c1/m1-abcd",
        **overrides,
    }
    return client.post("/segment/start", json=body).json()


def wait_for_completion(client: TestClient, job_id: str = "j1", timeout: float = 3.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = client.get(f"/segment/{job_id}").json()
        if status["state"] in {"complete", "failed", "cancelled"}:
            return status
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not finish: {client.get(f'/segment/{job_id}').json()}")


class TestCapabilities:
    def test_reports_readiness(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine())
        body = client.get("/segment/capabilities").json()
        assert body["available"] is True
        assert body["propagates"] is True

    def test_explains_why_it_cannot_run(self, client: TestClient) -> None:
        # Greyed with a reason, never hidden: the rule this project applies to every unavailable
        # capability.
        use_engine(client, ScriptedEngine(available=False))
        body = client.get("/segment/capabilities").json()
        assert body["available"] is False
        assert "sam2" in body["detail"]

    def test_requires_a_token(self, anonymous_client: TestClient) -> None:
        assert anonymous_client.get("/segment/capabilities").status_code == 401


class TestStart:
    def test_queues_a_job(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine())
        body = start(client)
        assert body["job_id"] == "j1"
        assert body["expected_frames"] == 3
        wait_for_completion(client)

    def test_rejects_a_request_with_no_points(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine())
        response = client.post(
            "/segment/start",
            json={
                "job_id": "j1",
                "source": "media/landscape.mp4",
                "start_frame": 0,
                "end_frame": 3,
                "points": [],
                "cache_folder": "masks/c1/m1",
            },
        )
        # Rejected by the model layer before the service is reached.
        assert response.status_code == 422

    def test_rejects_a_point_outside_the_frame(self, client: TestClient) -> None:
        # Coordinates are normalized; a pixel value slipping through would put every click in the
        # corner and produce a mask of the wrong thing.
        use_engine(client, ScriptedEngine())
        response = client.post(
            "/segment/start",
            json={
                "job_id": "j1",
                "source": "media/landscape.mp4",
                "start_frame": 0,
                "end_frame": 3,
                "points": [{"frame": 0, "x": 960, "y": 540}],
                "cache_folder": "masks/c1/m1",
            },
        )
        assert response.status_code == 422

    def test_rejects_a_missing_source(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine())
        response = client.post(
            "/segment/start",
            json={
                "job_id": "j1",
                "source": "media/nothing.mp4",
                "start_frame": 0,
                "end_frame": 3,
                "points": [{"frame": 0, "x": 0.5, "y": 0.5}],
                "cache_folder": "masks/c1/m1",
            },
        )
        assert response.status_code == 404

    def test_refuses_to_escape_the_project(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine())
        response = client.post(
            "/segment/start",
            json={
                "job_id": "j1",
                "source": "../../etc/passwd",
                "start_frame": 0,
                "end_frame": 3,
                "points": [{"frame": 0, "x": 0.5, "y": 0.5}],
                "cache_folder": "masks/c1/m1",
            },
        )
        assert response.status_code in {400, 403, 404}

    def test_reports_an_unavailable_engine_as_503(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine(available=False))
        response = client.post(
            "/segment/start",
            json={
                "job_id": "j1",
                "source": "media/landscape.mp4",
                "start_frame": 0,
                "end_frame": 3,
                "points": [{"frame": 0, "x": 0.5, "y": 0.5}],
                "cache_folder": "masks/c1/m1",
            },
        )
        assert response.status_code == 503
        assert "sam2" in response.json()["detail"]

    def test_requires_a_token(self, anonymous_client: TestClient) -> None:
        assert anonymous_client.post("/segment/start", json={}).status_code == 401


class TestPolling:
    def test_returns_masks_as_they_arrive(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine(frames=3))
        start(client)
        wait_for_completion(client)

        body = client.get("/segment/j1/frames").json()
        assert [frame["frame"] for frame in body["frames"]] == [0, 1, 2]
        assert body["next_cursor"] == 3

    def test_returns_only_what_is_new_since_the_cursor(self, client: TestClient) -> None:
        # The cursor is what makes a dropped connection cost nothing: the client asks again from
        # where it was rather than re-reading every mask.
        use_engine(client, ScriptedEngine(frames=3))
        start(client)
        wait_for_completion(client)

        body = client.get("/segment/j1/frames", params={"since": 2}).json()
        assert [frame["frame"] for frame in body["frames"]] == [2]

    def test_returns_nothing_past_the_end(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine(frames=3))
        start(client)
        wait_for_completion(client)
        assert client.get("/segment/j1/frames", params={"since": 99}).json()["frames"] == []

    def test_carries_the_run_length_counts_as_the_codec_writes_them(
        self, client: TestClient
    ) -> None:
        use_engine(client, ScriptedEngine(frames=1))
        start(client)
        wait_for_completion(client)

        frame = client.get("/segment/j1/frames").json()["frames"][0]
        assert frame["counts"] == encode_rle([1, 0, 0, 1], 2, 2)
        assert frame["width"] == 2

    def test_unknown_job_is_a_404(self, client: TestClient) -> None:
        assert client.get("/segment/nope").status_code == 404


class TestCancel:
    def test_keeps_what_was_produced(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine(frames=50, delay=0.01))
        start(client, end_frame=50)
        time.sleep(0.05)

        body = client.post("/segment/j1/cancel").json()
        assert body["state"] == str(SegmentState.CANCELLED)
        assert 0 < body["frames_done"] < 50

    def test_unknown_job_is_a_404(self, client: TestClient) -> None:
        assert client.post("/segment/nope/cancel").status_code == 404


class TestWriting:
    def test_writes_masks_under_the_project(self, client: TestClient, project: Path) -> None:
        use_engine(client, ScriptedEngine(frames=2))
        start(client)
        wait_for_completion(client)

        client.post("/segment/j1/write", params={"folder": "masks/c1/m1-abcd"})
        folder = project / "masks" / "c1" / "m1-abcd"
        assert sorted(path.name for path in folder.iterdir()) == ["000000.rle", "000001.rle"]

    def test_the_written_form_is_readable(self, client: TestClient, project: Path) -> None:
        # Dimensions first, then the runs. Being able to read one in a terminal has repeatedly been
        # worth more than the bytes saved.
        use_engine(client, ScriptedEngine(frames=1))
        start(client)
        wait_for_completion(client)
        client.post("/segment/j1/write", params={"folder": "masks/c1/m1-abcd"})

        text = (project / "masks" / "c1" / "m1-abcd" / "000000.rle").read_text(encoding="utf-8")
        assert text.startswith("2 2\n")

    def test_refuses_a_folder_outside_the_project(self, client: TestClient) -> None:
        use_engine(client, ScriptedEngine(frames=1))
        start(client)
        wait_for_completion(client)

        response = client.post("/segment/j1/write", params={"folder": "../escaped"})
        assert response.status_code in {400, 403}


@pytest.mark.parametrize(
    "path",
    ["/segment/capabilities", "/segment/j1", "/segment/j1/frames"],
)
def test_every_segment_endpoint_requires_a_token(anonymous_client: TestClient, path: str) -> None:
    # Asserted per endpoint rather than once: a route added later without the dependency would
    # otherwise be an unauthenticated hole nobody notices.
    assert anonymous_client.get(path).status_code == 401
