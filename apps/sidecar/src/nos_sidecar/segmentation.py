"""Segmentation worker.

The spec's M11: click an object on a frame, propagate the mask over the clip's range, cache it
under ``masks/``. The model is SAM 2, but nothing in this module is written *to* SAM 2 — the engine
is a protocol, so a different segmenter, or the same job done by a ComfyUI graph, drops in without
touching the service, the endpoints or the renderer.

## Availability is reported, never hidden

SAM 2 is a heavyweight optional dependency: a checkpoint, a CUDA build, a compatible torch. When it
is missing, ``capabilities()`` says so with a concrete reason and the UI greys the tool with that
reason attached. This is the same rule the generator registry follows, and for the same reason —
a feature that silently vanishes turns "where did segmentation go" into an afternoon.

## GPU serialization

The global semaphore lives in the renderer, which serializes generator runs, prompt-expansion LLMs
and segmentation against each other. This service holds a second, local single-slot lock: it
guards against two segmentation jobs inside *this* process, which the global semaphore cannot see if
a caller misuses it.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from .rle import encode_rle, is_well_formed, serialize_frame


class SegmentState(StrEnum):
    """Lifecycle of a segmentation job."""

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True, slots=True)
class Point:
    """A click, normalized to ``[0, 1]`` so a proxy and a master agree."""

    frame: int
    x: float
    y: float
    include: bool


@dataclass(frozen=True, slots=True)
class SegmentRequest:
    """One propagation."""

    source: Path
    start_frame: int
    end_frame: int
    points: tuple[Point, ...]


@dataclass(frozen=True, slots=True)
class MaskFrame:
    """One frame's mask, run-length encoded."""

    frame: int
    width: int
    height: int
    counts: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class Capabilities:
    """What the engine can do, and why not when it cannot."""

    available: bool
    propagates: bool
    detail: str = ""
    model: str = ""


class SegmentationEngine(Protocol):
    """The segmenter's contract. Mirrors ``@nos/masks``'s ``Segmenter``."""

    name: str

    def capabilities(self) -> Capabilities:
        """Report readiness. Never raises: an unavailable engine is a state, not an error."""
        ...

    def run(self, request: SegmentRequest) -> AsyncIterator[MaskFrame]:
        """Yield masks in frame order as they are produced."""
        ...


class Sam2Engine:
    """SAM 2, when it is installed.

    Loaded lazily and probed rather than imported at module scope: importing torch costs seconds and
    a large amount of memory, and the sidecar must start instantly for a project that never opens
    the segmentation panel.
    """

    name = "sam2"

    def __init__(self, checkpoint: Path | None = None) -> None:
        self._checkpoint = checkpoint

    def capabilities(self) -> Capabilities:
        if importlib.util.find_spec("sam2") is None:
            return Capabilities(
                available=False,
                propagates=False,
                detail=(
                    "the `sam2` package is not installed in the sidecar environment; "
                    "install it and restart to enable segmentation"
                ),
            )
        if importlib.util.find_spec("torch") is None:
            return Capabilities(
                available=False,
                propagates=False,
                detail="`sam2` is installed but `torch` is not; segmentation cannot run",
            )
        if self._checkpoint is not None and not self._checkpoint.exists():
            return Capabilities(
                available=False,
                propagates=False,
                detail=f"the SAM 2 checkpoint was not found at {self._checkpoint}",
            )
        return Capabilities(available=True, propagates=True, model="sam2", detail="")

    async def run(self, request: SegmentRequest) -> AsyncIterator[MaskFrame]:
        capabilities = self.capabilities()
        if not capabilities.available:
            raise EngineUnavailableError(capabilities.detail)

        # Deliberately not implemented against a specific SAM 2 release here: the import surface has
        # changed across versions, and binding to one would make the sidecar fail to start on the
        # next. The adapter is supplied by whoever installs the model, through `register_engine`.
        raise EngineUnavailableError(
            "no SAM 2 adapter is registered; call register_engine() with one that matches "
            "the installed sam2 version"
        )
        yield  # pragma: no cover - makes this an async generator


class EngineUnavailableError(RuntimeError):
    """The engine cannot run, with a reason fit to show a user."""


class SegmentationError(Exception):
    """A segmentation request that cannot be served."""

    def __init__(self, kind: str, detail: str, status: int = 400) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.status = status


@dataclass(slots=True)
class SegmentJob:
    """One propagation in flight."""

    job_id: str
    request: SegmentRequest
    state: SegmentState = SegmentState.QUEUED
    frames: list[MaskFrame] = field(default_factory=list)
    error: str | None = None
    task: asyncio.Task[None] | None = None
    folder: Path | None = None

    @property
    def expected(self) -> int:
        return max(0, self.request.end_frame - self.request.start_frame)

    @property
    def progress(self) -> float:
        """Fraction complete.

        Zero rather than one for an empty range: a bar reading 100% for a job that produced nothing
        is worse than one reading 0%.
        """
        return len(self.frames) / self.expected if self.expected > 0 else 0.0


class SegmentationService:
    """Runs segmentation jobs and writes their masks under ``masks/``."""

    def __init__(self, root: Path, engine: SegmentationEngine | None = None) -> None:
        self.root = root.resolve()
        self._engine: SegmentationEngine = engine or Sam2Engine()
        self._jobs: dict[str, SegmentJob] = {}
        # A local guard only. The global GPU semaphore lives in the renderer and serializes this
        # against generator runs, which this process cannot see.
        self._gpu = asyncio.Semaphore(1)

    def register_engine(self, engine: SegmentationEngine) -> None:
        """Swap the engine.

        How an installed SAM 2 build is bound in without this module knowing anything about it.
        """
        self._engine = engine

    def capabilities(self) -> Capabilities:
        return self._engine.capabilities()

    def get(self, job_id: str) -> SegmentJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise SegmentationError("unknown-job", f"no segmentation job {job_id}", status=404)
        return job

    def active(self) -> list[SegmentJob]:
        return [
            job
            for job in self._jobs.values()
            if job.state in {SegmentState.QUEUED, SegmentState.RUNNING}
        ]

    async def start(self, job_id: str, request: SegmentRequest) -> SegmentJob:
        """Queue a propagation.

        Validated before the engine is touched so the common mistakes — no click, an empty range, a
        missing file — come back as a clear rejection rather than a model error five seconds later.
        """
        if job_id in self._jobs:
            raise SegmentationError(
                "duplicate-job", f"segmentation job {job_id} already exists", status=409
            )
        if not request.points:
            raise SegmentationError("no-prompts", "segmentation needs at least one point")
        if request.end_frame <= request.start_frame:
            raise SegmentationError("empty-range", "the propagation range is empty")
        if not request.source.exists():
            raise SegmentationError("source-missing", f"{request.source} was not found", status=404)

        capabilities = self._engine.capabilities()
        if not capabilities.available:
            raise SegmentationError("unavailable", capabilities.detail, status=503)

        job = SegmentJob(job_id=job_id, request=request)
        self._jobs[job_id] = job
        job.task = asyncio.create_task(self._run(job))
        return job

    async def cancel(self, job: SegmentJob) -> SegmentJob:
        """Stop a job, keeping whatever it already produced.

        Partial results survive on purpose: 300 frames of a 500-frame propagation is 300 frames of
        expensive work, and the session model upstream is built to keep them.
        """
        if job.task is not None and not job.task.done():
            job.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await job.task
        if job.state in {SegmentState.QUEUED, SegmentState.RUNNING}:
            job.state = SegmentState.CANCELLED
        return job

    async def _run(self, job: SegmentJob) -> None:
        async with self._gpu:
            job.state = SegmentState.RUNNING
            try:
                async for mask in self._engine.run(job.request):
                    if not is_well_formed(list(mask.counts), mask.width, mask.height):
                        # A malformed mask must not reach the cache: it would decode into a shape
                        # with a tear in it and be blamed on the model.
                        raise SegmentationError(
                            "malformed-mask",
                            f"the engine produced a mask for frame {mask.frame} that does "
                            f"not cover {mask.width}x{mask.height}",
                        )
                    job.frames.append(mask)
                job.state = SegmentState.COMPLETE
            except asyncio.CancelledError:
                job.state = SegmentState.CANCELLED
                raise
            except EngineUnavailableError as error:
                job.state = SegmentState.FAILED
                job.error = str(error)
            except Exception as error:
                job.state = SegmentState.FAILED
                job.error = f"{type(error).__name__}: {error}"

    def write_masks(self, job: SegmentJob, folder: Path) -> Path:
        """Write a job's masks into the cache folder the renderer chose.

        The renderer owns the key — it is the side that knows the prompts and the source — so the
        sidecar is told where to write rather than deciding. That keeps one definition of the cache
        key instead of two that must agree.
        """
        folder.mkdir(parents=True, exist_ok=True)
        for mask in job.frames:
            path = folder / f"{mask.frame:06d}.rle"
            path.write_text(
                serialize_frame(list(mask.counts), mask.width, mask.height), encoding="utf-8"
            )
        job.folder = folder
        return folder


def masks_from_bitmaps(
    frames: Sequence[tuple[int, Sequence[int]]], width: int, height: int
) -> list[MaskFrame]:
    """Encode raw bitmaps into mask frames. The seam an engine adapter writes against."""
    return [
        MaskFrame(
            frame=frame, width=width, height=height, counts=tuple(encode_rle(bitmap, width, height))
        )
        for frame, bitmap in frames
    ]
