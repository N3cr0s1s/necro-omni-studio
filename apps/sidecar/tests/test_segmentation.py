"""The segmentation worker.

Exercised with a scripted engine rather than SAM 2. The service's job is scheduling, validation,
partial-result retention and cache writing — none of which need a model, and all of which are the
parts that would otherwise only be tested by someone with a GPU and a checkpoint.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from nos_sidecar.rle import encode_rle
from nos_sidecar.segmentation import (
    Capabilities,
    EngineUnavailableError,
    MaskFrame,
    Point,
    Sam2Engine,
    SegmentationError,
    SegmentationService,
    SegmentRequest,
    SegmentState,
    masks_from_bitmaps,
)


class ScriptedEngine:
    """An engine whose output the test dictates."""

    name = "scripted"

    def __init__(
        self,
        frames: int = 3,
        *,
        available: bool = True,
        fail_after: int | None = None,
        delay: float = 0,
        malformed: bool = False,
    ) -> None:
        self._frames = frames
        self._available = available
        self._fail_after = fail_after
        self._delay = delay
        self._malformed = malformed
        self.calls = 0

    def capabilities(self) -> Capabilities:
        return Capabilities(
            available=self._available,
            propagates=True,
            detail="" if self._available else "no model installed",
            model="scripted",
        )

    async def run(self, request: SegmentRequest) -> AsyncIterator[MaskFrame]:
        self.calls += 1
        for index in range(self._frames):
            if self._fail_after is not None and index == self._fail_after:
                raise RuntimeError("the model ran out of memory")
            if self._delay:
                await asyncio.sleep(self._delay)
            counts = (0, 3) if self._malformed else tuple(encode_rle([1, 0, 0, 1], 2, 2))
            yield MaskFrame(frame=request.start_frame + index, width=2, height=2, counts=counts)


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "shot.mp4"
    path.write_bytes(b"not really a video, but it exists")
    return path


def request_for(source: Path, *, start: int = 10, end: int = 13) -> SegmentRequest:
    return SegmentRequest(
        source=source,
        start_frame=start,
        end_frame=end,
        points=(Point(frame=start, x=0.5, y=0.5, include=True),),
    )


async def drain(service: SegmentationService, job_id: str) -> None:
    job = service.get(job_id)
    if job.task is not None:
        await job.task


@pytest.mark.asyncio
async def test_runs_and_collects_frames(tmp_path: Path, source: Path) -> None:
    service = SegmentationService(tmp_path, ScriptedEngine(frames=3))
    await service.start("j1", request_for(source))
    await drain(service, "j1")

    job = service.get("j1")
    assert job.state is SegmentState.COMPLETE
    assert [mask.frame for mask in job.frames] == [10, 11, 12]


@pytest.mark.asyncio
async def test_reports_progress_against_the_requested_range(tmp_path: Path, source: Path) -> None:
    service = SegmentationService(tmp_path, ScriptedEngine(frames=3))
    await service.start("j1", request_for(source, start=0, end=6))
    await drain(service, "j1")

    assert service.get("j1").progress == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_an_empty_range_never_looks_complete(tmp_path: Path, source: Path) -> None:
    # Zero rather than one: a progress bar that reads 100% for a job that produced nothing is worse
    # than one that reads 0%.
    service = SegmentationService(tmp_path, ScriptedEngine(frames=0))
    await service.start("j1", request_for(source, start=0, end=1))
    await drain(service, "j1")
    assert service.get("j1").progress == 0.0


@pytest.mark.asyncio
async def test_keeps_partial_results_when_the_engine_fails(tmp_path: Path, source: Path) -> None:
    # 300 frames of a 500-frame propagation is 300 frames of expensive work; discarding them because
    # the run did not finish would be the worst possible response to a failure.
    service = SegmentationService(tmp_path, ScriptedEngine(frames=5, fail_after=2))
    await service.start("j1", request_for(source, start=0, end=5))
    await drain(service, "j1")

    job = service.get("j1")
    assert job.state is SegmentState.FAILED
    assert len(job.frames) == 2
    assert "out of memory" in (job.error or "")


@pytest.mark.asyncio
async def test_rejects_a_malformed_mask_before_it_reaches_the_cache(
    tmp_path: Path, source: Path
) -> None:
    # A mask that does not cover its frame would decode into a shape with a tear in it and be blamed
    # on the model.
    service = SegmentationService(tmp_path, ScriptedEngine(frames=2, malformed=True))
    await service.start("j1", request_for(source))
    await drain(service, "j1")

    job = service.get("j1")
    assert job.state is SegmentState.FAILED
    assert "does not cover" in (job.error or "")


@pytest.mark.asyncio
async def test_cancellation_keeps_what_was_produced(tmp_path: Path, source: Path) -> None:
    service = SegmentationService(tmp_path, ScriptedEngine(frames=50, delay=0.01))
    await service.start("j1", request_for(source, start=0, end=50))
    await asyncio.sleep(0.05)
    job = await service.cancel(service.get("j1"))

    assert job.state is SegmentState.CANCELLED
    assert len(job.frames) > 0
    assert len(job.frames) < 50


@pytest.mark.asyncio
async def test_serializes_jobs_against_each_other(tmp_path: Path, source: Path) -> None:
    # The global GPU semaphore lives in the renderer; this local one guards against a caller that
    # misuses it, which would otherwise put two models in VRAM at once.
    engine = ScriptedEngine(frames=3, delay=0.01)
    service = SegmentationService(tmp_path, engine)

    await service.start("j1", request_for(source))
    await service.start("j2", request_for(source))
    await asyncio.sleep(0.015)

    states = {service.get("j1").state, service.get("j2").state}
    assert SegmentState.QUEUED in states

    await drain(service, "j1")
    await drain(service, "j2")
    assert service.get("j2").state is SegmentState.COMPLETE


@pytest.mark.asyncio
async def test_rejects_a_request_with_no_prompts(tmp_path: Path, source: Path) -> None:
    service = SegmentationService(tmp_path, ScriptedEngine())
    with pytest.raises(SegmentationError) as error:
        await service.start(
            "j1", SegmentRequest(source=source, start_frame=0, end_frame=5, points=())
        )
    assert error.value.kind == "no-prompts"


@pytest.mark.asyncio
async def test_rejects_an_empty_range(tmp_path: Path, source: Path) -> None:
    service = SegmentationService(tmp_path, ScriptedEngine())
    with pytest.raises(SegmentationError) as error:
        await service.start("j1", request_for(source, start=10, end=10))
    assert error.value.kind == "empty-range"


@pytest.mark.asyncio
async def test_rejects_a_missing_source(tmp_path: Path) -> None:
    service = SegmentationService(tmp_path, ScriptedEngine())
    with pytest.raises(SegmentationError) as error:
        await service.start("j1", request_for(tmp_path / "gone.mp4"))
    assert error.value.status == 404


@pytest.mark.asyncio
async def test_rejects_a_duplicate_job_id(tmp_path: Path, source: Path) -> None:
    service = SegmentationService(tmp_path, ScriptedEngine())
    await service.start("j1", request_for(source))
    with pytest.raises(SegmentationError) as error:
        await service.start("j1", request_for(source))
    assert error.value.status == 409
    await drain(service, "j1")


@pytest.mark.asyncio
async def test_refuses_to_start_when_the_engine_is_unavailable(
    tmp_path: Path, source: Path
) -> None:
    # Reported with its reason, never silently. The same rule the generator registry follows.
    service = SegmentationService(tmp_path, ScriptedEngine(available=False))
    with pytest.raises(SegmentationError) as error:
        await service.start("j1", request_for(source))

    assert error.value.status == 503
    assert error.value.detail == "no model installed"


@pytest.mark.asyncio
async def test_writes_masks_where_the_renderer_asked(tmp_path: Path, source: Path) -> None:
    # The renderer owns the cache key, so it chooses the folder — one definition instead of two that
    # have to agree.
    service = SegmentationService(tmp_path, ScriptedEngine(frames=2))
    await service.start("j1", request_for(source))
    await drain(service, "j1")

    folder = tmp_path / "masks" / "c1" / "m1-abcd1234"
    service.write_masks(service.get("j1"), folder)

    written = sorted(path.name for path in folder.iterdir())
    assert written == ["000010.rle", "000011.rle"]
    assert (folder / "000010.rle").read_text(encoding="utf-8").startswith("2 2\n")


def test_unknown_job_is_a_404(tmp_path: Path) -> None:
    service = SegmentationService(tmp_path, ScriptedEngine())
    with pytest.raises(SegmentationError) as error:
        service.get("nope")
    assert error.value.status == 404


def test_masks_from_bitmaps_encodes_column_major() -> None:
    masks = masks_from_bitmaps([(7, [1, 0, 1, 0])], 2, 2)
    assert masks[0].frame == 7
    assert list(masks[0].counts) == encode_rle([1, 0, 1, 0], 2, 2)


class TestSam2Engine:
    """The default engine, which is expected to be unavailable in this environment."""

    def test_reports_a_concrete_reason_when_sam2_is_absent(self) -> None:
        capabilities = Sam2Engine().capabilities()
        if capabilities.available:
            pytest.skip("sam2 is installed in this environment")
        assert "sam2" in capabilities.detail
        # The reason must say what to do, not merely that something is wrong.
        assert "install" in capabilities.detail

    @pytest.mark.asyncio
    async def test_refuses_to_run_rather_than_producing_nothing(self, tmp_path: Path) -> None:
        engine = Sam2Engine()
        if engine.capabilities().available:
            pytest.skip("sam2 is installed in this environment")

        with pytest.raises(EngineUnavailableError):
            async for _mask in engine.run(
                SegmentRequest(
                    source=tmp_path,
                    start_frame=0,
                    end_frame=1,
                    points=(Point(frame=0, x=0.5, y=0.5, include=True),),
                )
            ):
                pass

    def test_reports_a_missing_checkpoint_by_path(self, tmp_path: Path) -> None:
        capabilities = Sam2Engine(checkpoint=tmp_path / "sam2.pt").capabilities()
        assert not capabilities.available
        assert capabilities.detail != ""
