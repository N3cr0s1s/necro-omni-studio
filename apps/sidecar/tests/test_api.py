"""End-to-end API tests against real ffmpeg and real files.

Nothing is mocked. The sidecar's entire purpose is to drive ffmpeg correctly and to refuse paths it
should not read, and neither property survives being stubbed.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nos_sidecar.peaks import decode_peaks

from .conftest import TOKEN, TONE_AMPLITUDE


class TestHealth:
    def test_reports_ready_without_a_token(self, anonymous_client: TestClient) -> None:
        # The parent process polls this to learn when the port is live.
        response = anonymous_client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["ffmpeg"] and body["ffprobe"]

    def test_never_echoes_the_token(self, anonymous_client: TestClient) -> None:
        assert "test-token" not in anonymous_client.get("/health").text


class TestAuthentication:
    def test_rejects_a_request_with_no_token(self, anonymous_client: TestClient) -> None:
        response = anonymous_client.post("/media/probe", json={"asset": "media/landscape.mp4"})
        assert response.status_code == 401

    def test_rejects_a_wrong_token(self, anonymous_client: TestClient) -> None:
        response = anonymous_client.post(
            "/media/probe",
            json={"asset": "media/landscape.mp4"},
            headers={"X-Nos-Token": "wrong"},
        )
        assert response.status_code == 401

    def test_protects_the_file_endpoint(self, anonymous_client: TestClient) -> None:
        # The most dangerous endpoint: it returns file bytes.
        assert (
            anonymous_client.get("/media/file", params={"asset": "notes/treatment.md"}).status_code
            == 401
        )


class TestProbe:
    def test_reads_a_landscape_video_with_audio(self, client: TestClient) -> None:
        response = client.post("/media/probe", json={"asset": "media/landscape.mp4"})
        assert response.status_code == 200
        body = response.json()

        assert body["type"] == "video"
        assert body["video"]["width"] == 320
        assert body["video"]["height"] == 180
        # Exact rational, never a rounded float.
        assert body["video"]["frame_rate"] == "30/1"
        assert body["video"]["variable_frame_rate"] is False
        assert body["video"]["frames"] > 0
        assert body["audio"]["channels"] >= 1
        assert body["audio"]["sample_rate"] > 0
        assert body["hash"]
        assert body["size_bytes"] > 0

    def test_classifies_an_audio_only_container_as_audio(self, client: TestClient) -> None:
        response = client.post("/media/probe", json={"asset": "media/tone.flac"})
        assert response.status_code == 200
        body = response.json()
        assert body["type"] == "audio"
        assert body["video"] is None
        assert body["audio"]["codec"] == "flac"

    def test_classifies_a_still_as_an_image(self, client: TestClient) -> None:
        response = client.post("/media/probe", json={"asset": "media/still.png"})
        assert response.status_code == 200
        body = response.json()
        assert body["type"] == "image"
        assert body["image"]["width"] == 64
        # A still must not be reported as video, or the timeline would size it from a frame count.
        assert body["video"] is None

    def test_reports_durations_for_a_batch(self, client: TestClient) -> None:
        response = client.post(
            "/media/durations", json={"assets": ["media/landscape.mp4", "media/still.png"]}
        )
        assert response.status_code == 200
        durations = response.json()["durations"]
        assert durations["media/landscape.mp4"] is not None
        # A still has no duration, and that is an answer rather than a failure.
        assert durations["media/still.png"] is None

    def test_answers_null_for_a_file_it_cannot_read(self, client: TestClient) -> None:
        """The whole reason this endpoint exists beside ``/media/probe``.

        A project legitimately holds media with no readable duration — a placeholder a generator has
        not written, a file still encoding. ``probe`` answers those with a 404 or a 422, correctly,
        because its question is "the metadata, or why not". A *listing* asks a different
        question, and a browser logs every 4xx to its console whatever the caller does with
        the promise — so one unreadable file meant a renderer error on every scan.
        """
        response = client.post(
            "/media/durations", json={"assets": ["media/nothing-here.mp4", "media/landscape.mp4"]}
        )
        assert response.status_code == 200
        durations = response.json()["durations"]
        assert durations["media/nothing-here.mp4"] is None
        assert durations["media/landscape.mp4"] is not None

    def test_takes_an_empty_batch_without_complaint(self, client: TestClient) -> None:
        response = client.post("/media/durations", json={"assets": []})
        assert response.status_code == 200
        assert response.json()["durations"] == {}

    def test_hashes_a_note_without_invoking_ffprobe(self, client: TestClient) -> None:
        response = client.post("/media/probe", json={"asset": "notes/treatment.md"})
        assert response.status_code == 200
        body = response.json()
        assert body["type"] == "text"
        assert body["hash"]

    def test_reports_a_stable_hash_across_calls(self, client: TestClient) -> None:
        first = client.post("/media/probe", json={"asset": "media/landscape.mp4"}).json()
        second = client.post("/media/probe", json={"asset": "media/landscape.mp4"}).json()
        assert first["hash"] == second["hash"]

    def test_rehashes_after_the_content_changes(self, client: TestClient, project: Path) -> None:
        # The property that makes the derived-artifact cache correct.
        before = client.post("/media/probe", json={"asset": "notes/treatment.md"}).json()["hash"]
        note = project / "notes" / "treatment.md"
        note.write_text("# Treatment v2\n", encoding="utf-8")
        after = client.post("/media/probe", json={"asset": "notes/treatment.md"}).json()["hash"]
        assert before != after

    def test_reports_a_missing_asset_as_not_found(self, client: TestClient) -> None:
        response = client.post("/media/probe", json={"asset": "media/nope.mp4"})
        assert response.status_code == 404
        assert response.json()["kind"] == "not-found"

    def test_refuses_a_traversal_path(self, client: TestClient) -> None:
        response = client.post("/media/probe", json={"asset": "../../etc/passwd"})
        assert response.status_code == 400
        assert response.json()["kind"] == "invalid-path"

    def test_refuses_an_absolute_path(self, client: TestClient) -> None:
        response = client.post("/media/probe", json={"asset": "/etc/passwd"})
        assert response.status_code == 400

    def test_rejects_unknown_request_fields(self, client: TestClient) -> None:
        # Strict input: a typo must not be silently ignored.
        response = client.post(
            "/media/probe", json={"asset": "media/landscape.mp4", "asset_typo": 1}
        )
        assert response.status_code == 422


class TestStill:
    """Lifting one frame out of a video as a project file.

    Deliberately not a derivation. A frame grabbed for a generator's first input is something the
    run is pinned to, and everything under ``cache/`` is regenerated under a hash-derived name and
    deleted whenever the cache is cleared.
    """

    def test_writes_the_frame_into_the_project(self, client: TestClient, project) -> None:
        response = client.post(
            "/media/still",
            json={
                "asset": "media/landscape.mp4",
                "seconds": 1.0,
                "destination": "media/stills/landscape_30.png",
            },
        )
        assert response.status_code == 200
        still = response.json()
        assert still["asset"] == "media/stills/landscape_30.png"
        assert still["reused"] is False
        assert (still["width"], still["height"]) == (320, 180)
        assert (project / "media" / "stills" / "landscape_30.png").exists()

    def test_leaves_no_partial_file_behind(self, client: TestClient, project) -> None:
        # The project folder is watched; a watcher that sees a half-written PNG hands the browser a
        # file it cannot decode.
        client.post(
            "/media/still",
            json={
                "asset": "media/landscape.mp4",
                "seconds": 0.5,
                "destination": "media/stills/a.png",
            },
        )
        assert list((project / "media" / "stills").glob("*.partial")) == []

    def test_reuses_a_frame_already_grabbed(self, client: TestClient) -> None:
        # Stepping back and forth between two candidate frames is the normal case.
        body = {
            "asset": "media/landscape.mp4",
            "seconds": 1.0,
            "destination": "media/stills/again.png",
        }
        assert client.post("/media/still", json=body).json()["reused"] is False
        assert client.post("/media/still", json=body).json()["reused"] is True

    def test_refuses_to_write_into_the_cache(self, client: TestClient) -> None:
        # Clearing the cache would break every run pinned to the frame.
        response = client.post(
            "/media/still",
            json={
                "asset": "media/landscape.mp4",
                "seconds": 1.0,
                "destination": "cache/grabbed.png",
            },
        )
        assert response.status_code == 400
        assert response.json()["kind"] == "invalid-path"

    def test_refuses_to_escape_the_project(self, client: TestClient) -> None:
        response = client.post(
            "/media/still",
            json={
                "asset": "media/landscape.mp4",
                "seconds": 1.0,
                "destination": "../escaped.png",
            },
        )
        assert response.status_code == 400

    def test_reports_a_timestamp_past_the_end(self, client: TestClient) -> None:
        # ffmpeg exits 0 having written nothing, which is reachable by asking for the last frame.
        response = client.post(
            "/media/still",
            json={
                "asset": "media/landscape.mp4",
                "seconds": 600.0,
                "destination": "media/stills/past.png",
            },
        )
        assert response.status_code == 422

    def test_rejects_a_negative_timestamp(self, client: TestClient) -> None:
        response = client.post(
            "/media/still",
            json={
                "asset": "media/landscape.mp4",
                "seconds": -1.0,
                "destination": "media/stills/neg.png",
            },
        )
        assert response.status_code == 422


class TestProxy:
    def test_constrains_the_short_edge_for_landscape(self, client: TestClient) -> None:
        response = client.post(
            "/media/derive",
            json={"asset": "media/landscape.mp4", "spec": {"kind": "proxy", "short_edge": 90}},
        )
        assert response.status_code == 200
        artifact = response.json()
        assert artifact["reused"] is False
        assert artifact["path"].startswith("cache/proxy_90p30q23_")

        probed = client.post("/media/probe", json={"asset": artifact["path"]}).json()
        assert probed["video"]["height"] == 90
        assert probed["video"]["width"] == 160

    def test_keeps_portrait_material_portrait(self, client: TestClient) -> None:
        # `short_edge` is the `p` number, not a cap on the long edge: 90p of 9:16 is 90x160.
        response = client.post(
            "/media/derive",
            json={"asset": "media/portrait.mp4", "spec": {"kind": "proxy", "short_edge": 90}},
        )
        assert response.status_code == 200
        probed = client.post("/media/probe", json={"asset": response.json()["path"]}).json()
        assert probed["video"]["width"] == 90
        assert probed["video"]["height"] == 160

    def test_reuses_a_cached_proxy(self, client: TestClient) -> None:
        spec = {"kind": "proxy", "short_edge": 90}
        first = client.post(
            "/media/derive", json={"asset": "media/landscape.mp4", "spec": spec}
        ).json()
        second = client.post(
            "/media/derive", json={"asset": "media/landscape.mp4", "spec": spec}
        ).json()
        assert first["reused"] is False
        assert second["reused"] is True
        assert first["path"] == second["path"]

    def test_a_different_spec_produces_a_different_artifact(self, client: TestClient) -> None:
        # Otherwise a settings change would silently serve the previous resolution.
        low = client.post(
            "/media/derive",
            json={"asset": "media/landscape.mp4", "spec": {"kind": "proxy", "short_edge": 90}},
        ).json()
        high = client.post(
            "/media/derive",
            json={"asset": "media/landscape.mp4", "spec": {"kind": "proxy", "short_edge": 120}},
        ).json()
        assert low["path"] != high["path"]

    def test_strips_audio_from_the_proxy(self, client: TestClient) -> None:
        artifact = client.post(
            "/media/derive",
            json={"asset": "media/landscape.mp4", "spec": {"kind": "proxy", "short_edge": 90}},
        ).json()
        probed = client.post("/media/probe", json={"asset": artifact["path"]}).json()
        assert probed["audio"] is None

    def test_rejects_an_out_of_range_spec(self, client: TestClient) -> None:
        response = client.post(
            "/media/derive",
            json={"asset": "media/landscape.mp4", "spec": {"kind": "proxy", "short_edge": 0}},
        )
        assert response.status_code == 422


class TestFilmstrip:
    def test_tiles_thumbnails_into_one_image(self, client: TestClient) -> None:
        response = client.post(
            "/media/derive",
            json={
                "asset": "media/landscape.mp4",
                "spec": {"kind": "filmstrip", "thumbnail_height": 20, "thumbnails_per_second": 2},
            },
        )
        assert response.status_code == 200
        probed = client.post("/media/probe", json={"asset": response.json()["path"]}).json()
        # A 2 s source at 2/s yields 4 tiles side by side, each 20px tall.
        assert probed["image"]["height"] == 20
        assert probed["image"]["width"] > 20 * 3

    def test_reports_what_the_strip_spans(self, client: TestClient) -> None:
        # Without this the renderer cannot place the strip against a clip: the image covers the
        # whole asset, so drawing the range a trimmed clip shows needs to know how much it holds.
        artifact = client.post(
            "/media/derive",
            json={
                "asset": "media/landscape.mp4",
                "spec": {"kind": "filmstrip", "thumbnail_height": 20, "thumbnails_per_second": 2},
            },
        ).json()

        coverage = artifact["filmstrip"]
        assert coverage["columns"] == 4
        assert coverage["thumbnails_per_second"] == 2
        assert coverage["duration_seconds"] == pytest.approx(2.0, abs=0.2)

    def test_reports_coverage_from_the_cache_too(self, client: TestClient) -> None:
        # The second open of a project is the common case, and a reused strip that arrived without
        # its description would be placed wrongly rather than not at all.
        request = {
            "asset": "media/landscape.mp4",
            "spec": {"kind": "filmstrip", "thumbnail_height": 24, "thumbnails_per_second": 1},
        }
        first = client.post("/media/derive", json=request).json()
        second = client.post("/media/derive", json=request).json()

        assert second["reused"] is True
        assert second["filmstrip"] == first["filmstrip"]

    def test_reproduces_a_strip_whose_description_was_lost(
        self, client: TestClient, project: Path
    ) -> None:
        request = {
            "asset": "media/landscape.mp4",
            "spec": {"kind": "filmstrip", "thumbnail_height": 28, "thumbnails_per_second": 1},
        }
        first = client.post("/media/derive", json=request).json()
        artifact = project / first["path"]
        artifact.with_name(f".{artifact.name}.meta.json").unlink()

        second = client.post("/media/derive", json=request).json()
        assert second["reused"] is False
        assert second["filmstrip"] == first["filmstrip"]

    def test_keeps_the_description_out_of_the_project_view(
        self, client: TestClient, project: Path
    ) -> None:
        client.post(
            "/media/derive",
            json={
                "asset": "media/landscape.mp4",
                "spec": {"kind": "filmstrip", "thumbnail_height": 32, "thumbnails_per_second": 1},
            },
        )
        entries = client.post("/project/scan", json={}).json()["entries"]
        assert not any(entry["path"].endswith(".meta.json") for entry in entries)


class TestWaveform:
    def test_produces_decodable_peaks(self, client: TestClient, project: Path) -> None:
        response = client.post(
            "/media/derive",
            json={
                "asset": "media/tone.flac",
                "spec": {"kind": "waveform", "buckets_per_second": 50},
            },
        )
        assert response.status_code == 200
        artifact = response.json()

        data = decode_peaks((project / artifact["path"]).read_bytes())
        assert data.buckets_per_second == 50
        assert data.channels == 1
        # A 2 s source at 50 buckets/s is ~100 buckets.
        assert 90 <= data.bucket_count <= 110
        assert len(data.values) == data.bucket_count * 2

    def test_peaks_reproduce_the_source_amplitude(self, client: TestClient, project: Path) -> None:
        artifact = client.post(
            "/media/derive",
            json={"asset": "media/tone.flac", "spec": {"kind": "waveform"}},
        ).json()
        data = decode_peaks((project / artifact["path"]).read_bytes())

        minima = [data.values[i] for i in range(0, len(data.values), 2)]
        maxima = [data.values[i] for i in range(1, len(data.values), 2)]

        # The tone is generated at a known amplitude, so this checks that the reduction
        # preserves level rather than merely producing "something large". Tolerance covers s16
        # quantization in FLAC plus resampling to the peak rate.
        assert max(maxima) == pytest.approx(TONE_AMPLITUDE, abs=0.02)
        assert min(minima) == pytest.approx(-TONE_AMPLITUDE, abs=0.02)
        assert all(-1.0 <= value <= 1.0 for value in data.values)

    def test_refuses_a_source_with_no_audio(self, client: TestClient) -> None:
        response = client.post(
            "/media/derive",
            json={"asset": "media/portrait.mp4", "spec": {"kind": "waveform"}},
        )
        assert response.status_code == 422
        assert response.json()["kind"] == "unsupported"


class TestFileServing:
    def test_serves_a_project_file(self, client: TestClient) -> None:
        response = client.get("/media/file", params={"asset": "notes/treatment.md"})
        assert response.status_code == 200
        assert "Treatment" in response.text

    def test_accepts_the_token_as_a_query_parameter(self, anonymous_client: TestClient) -> None:
        # `<video src>` and `<img src>` cannot send headers, so the renderer builds URLs carrying
        # the token. This endpoint is the only one that must accept it that way.
        response = anonymous_client.get(
            "/media/file", params={"asset": "notes/treatment.md", "token": TOKEN}
        )
        assert response.status_code == 200

    def test_rejects_a_wrong_query_token(self, anonymous_client: TestClient) -> None:
        response = anonymous_client.get(
            "/media/file", params={"asset": "notes/treatment.md", "token": "wrong"}
        )
        assert response.status_code == 401

    def test_other_endpoints_do_not_accept_a_query_token(
        self, anonymous_client: TestClient
    ) -> None:
        # A token in a URL is easier to leak, so the concession is scoped to /media/file only.
        response = anonymous_client.post(
            "/media/probe",
            params={"token": TOKEN},
            json={"asset": "media/landscape.mp4"},
        )
        assert response.status_code == 401

    def test_refuses_to_serve_outside_the_project(self, client: TestClient) -> None:
        response = client.get("/media/file", params={"asset": "../../etc/passwd"})
        assert response.status_code == 400


class TestScan:
    def test_lists_project_media(self, client: TestClient) -> None:
        response = client.post("/project/scan", json={})
        assert response.status_code == 200
        paths = {entry["path"] for entry in response.json()["entries"]}
        assert "media/landscape.mp4" in paths
        assert "notes/treatment.md" in paths
        assert "media" in paths

    def test_reports_the_cache_folder_but_not_its_contents(self, client: TestClient) -> None:
        client.post(
            "/media/derive",
            json={"asset": "media/landscape.mp4", "spec": {"kind": "proxy", "short_edge": 90}},
        )
        entries = client.post("/project/scan", json={}).json()["entries"]
        paths = {entry["path"] for entry in entries}
        assert "cache" in paths
        assert not any(path.startswith("cache/") for path in paths)

    def test_hides_editor_and_os_droppings(self, client: TestClient, project: Path) -> None:
        (project / "media" / ".DS_Store").write_bytes(b"junk")
        (project / "media" / "half.mp4.part").write_bytes(b"incomplete")

        paths = {entry["path"] for entry in client.post("/project/scan", json={}).json()["entries"]}
        assert "media/.DS_Store" not in paths
        # An incomplete generator output must never be draggable onto the timeline.
        assert "media/half.mp4.part" not in paths

    def test_scopes_to_a_subtree(self, client: TestClient) -> None:
        entries = client.post("/project/scan", json={"subtree": "notes"}).json()["entries"]
        assert {entry["path"] for entry in entries} == {"notes/treatment.md"}

    def test_marks_directories(self, client: TestClient) -> None:
        entries = client.post("/project/scan", json={}).json()["entries"]
        media = next(entry for entry in entries if entry["path"] == "media")
        assert media["is_directory"] is True
        assert media["size_bytes"] == 0


class TestCache:
    def test_reports_and_clears_the_cache(self, client: TestClient) -> None:
        client.post(
            "/media/derive",
            json={"asset": "media/landscape.mp4", "spec": {"kind": "proxy", "short_edge": 90}},
        )
        stats = client.get("/cache/stats").json()
        assert stats["size_bytes"] > 0
        assert stats["file_count"] >= 1

        cleared = client.post("/cache/clear").json()
        assert cleared["size_bytes"] == 0
        assert cleared["file_count"] == 0

    def test_regenerates_after_a_clear(self, client: TestClient) -> None:
        spec = {"kind": "proxy", "short_edge": 90}
        client.post("/media/derive", json={"asset": "media/landscape.mp4", "spec": spec})
        client.post("/cache/clear")
        again = client.post(
            "/media/derive", json={"asset": "media/landscape.mp4", "spec": spec}
        ).json()
        # Clearing the cache must only cost time, never data.
        assert again["reused"] is False

    def test_clearing_leaves_source_media_untouched(
        self, client: TestClient, project: Path
    ) -> None:
        client.post("/cache/clear")
        assert (project / "media" / "landscape.mp4").exists()
        assert (project / "notes" / "treatment.md").exists()
