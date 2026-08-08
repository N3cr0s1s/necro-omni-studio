"""Frame encoding.

The renderer owns the GL context, so it produces frames; the sidecar owns ffmpeg, so it encodes
them. Raw
RGBA frames stream in over one long-lived request and go straight to ffmpeg's stdin.

## Why streaming rather than frame-by-frame requests

A 1080p RGBA frame is 8 MB. A three-minute export at 30 fps is 5400 frames — roughly 43 GB in total.
That
is fine to *stream* through a pipe on localhost, and hopeless as 5400 separate HTTP requests: the
per-request overhead and the buffering would dominate, and a stall between frames shows up as an
encoder
that keeps flushing partial GOPs.

So an export is one job with a stdin pipe held open, and the renderer writes into it at whatever
rate it
can render. ffmpeg applies backpressure naturally through the pipe.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from . import ffmpeg


class EncodeState(StrEnum):
    """Lifecycle of an encode job."""

    RUNNING = "running"
    FINISHING = "finishing"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(slots=True)
class EncodeJob:
    """One export in flight."""

    job_id: str
    output: Path
    width: int
    height: int
    frame_rate: str
    expected_frames: int
    process: asyncio.subprocess.Process
    state: EncodeState = EncodeState.RUNNING
    # Bytes are the source of truth, not a per-chunk frame count. Chunk boundaries do not align with
    # frame boundaries when streaming over HTTP, so dividing each chunk independently discards the
    # remainder every time and under-reports progress — three chunks of 3.33 frames would count 9
    # instead of 10.
    bytes_written: int = 0
    error: str | None = None
    # Captured continuously: ffmpeg writes its diagnostics to stderr, and reading it only after the
    # process exits risks filling the pipe buffer and deadlocking the encoder.
    stderr_tail: list[str] = field(default_factory=list)
    # A strong reference to the drain task. Without one the event loop keeps only a weak
    # reference, so the task can be garbage collected while still awaiting — which would stop
    # draining stderr and reintroduce the very deadlock the drain exists to prevent.
    drain_task: asyncio.Task[None] | None = None

    @property
    def bytes_per_frame(self) -> int:
        return self.width * self.height * 4

    @property
    def frames_written(self) -> int:
        """Whole frames the encoder has received, derived from the running byte total."""
        return self.bytes_written // self.bytes_per_frame


class EncodeError(Exception):
    """An encode operation failed in a way the renderer should surface."""

    def __init__(self, kind: str, detail: str, *, status: int = 400) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.status = status


# Keep the last few stderr lines only. The full log of a long encode is large and uninteresting; the
# tail is what names the failure.
STDERR_TAIL_LINES = 40


def encode_command(
    ffmpeg_binary: str,
    destination: Path,
    *,
    width: int,
    height: int,
    frame_rate: str,
    codec: str,
    crf: int,
    speed: str,
    audio_path: Path | None,
    audio_codec: str,
    audio_bitrate_kbps: int,
) -> list[str]:
    """Build the encode command for raw RGBA frames on stdin.

    ``-vf vflip`` is not optional: WebGL's framebuffer origin is bottom-left while every image and
    video
    format is top-left, so frames read back with ``readPixels`` arrive upside down. Flipping in
    ffmpeg
    rather than in the shader keeps the preview path free of a transform that exists only for
    export.

    The pixel format is forced to ``yuv420p`` regardless of codec. It is the only chroma layout
    every
    player handles; ffmpeg would otherwise pick ``yuv444p`` for some inputs and produce a file that
    plays
    in VLC and shows a black frame in QuickTime.
    """
    command = [
        ffmpeg_binary,
        "-hide_banner",
        "-nostdin",
        "-y",
        # Input: raw frames on stdin.
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        frame_rate,
        "-i",
        "pipe:0",
    ]

    if audio_path is not None:
        command += ["-i", str(audio_path)]

    command += [
        "-vf",
        "vflip",
        "-c:v",
        "libx264" if codec == "h264" else "libx265",
        "-preset",
        speed,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        # Progressive download support: without this the index sits at the end of the file and a
        # player cannot start until the whole thing is available.
        "-movflags",
        "+faststart",
    ]

    if audio_path is not None:
        command += ["-c:a", "aac" if audio_codec == "aac" else "flac"]
        if audio_codec == "aac":
            command += ["-b:a", f"{audio_bitrate_kbps}k"]
        # End when the shorter stream ends. Audio and video durations can differ by a frame from
        # rounding, and without this the file gains a tail of silence or a frozen frame.
        command += ["-shortest"]
    else:
        command += ["-an"]

    command += [str(destination)]
    return command


class EncoderService:
    """Owns the encode jobs for one project."""

    def __init__(self, root: Path, tooling: ffmpeg.Tooling) -> None:
        self._root = root
        self._tooling = tooling
        self._jobs: dict[str, EncodeJob] = {}

    def get(self, job_id: str) -> EncodeJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise EncodeError("not-found", f"no encode job {job_id}", status=404)
        return job

    async def start(
        self,
        job_id: str,
        destination: Path,
        *,
        width: int,
        height: int,
        frame_rate: str,
        codec: str,
        crf: int,
        speed: str,
        expected_frames: int,
        audio_path: Path | None,
        audio_codec: str,
        audio_bitrate_kbps: int,
    ) -> EncodeJob:
        if job_id in self._jobs:
            raise EncodeError("duplicate", f"encode job {job_id} already exists", status=409)

        destination.parent.mkdir(parents=True, exist_ok=True)

        command = encode_command(
            self._tooling.ffmpeg,
            destination,
            width=width,
            height=height,
            frame_rate=frame_rate,
            codec=codec,
            crf=crf,
            speed=speed,
            audio_path=audio_path,
            audio_codec=audio_codec,
            audio_bitrate_kbps=audio_bitrate_kbps,
        )

        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        job = EncodeJob(
            job_id=job_id,
            output=destination,
            width=width,
            height=height,
            frame_rate=frame_rate,
            expected_frames=expected_frames,
            process=process,
        )
        self._jobs[job_id] = job

        # Drain stderr concurrently. ffmpeg is chatty, and a full stderr pipe blocks the encoder —
        # which presents as an export that stalls partway through with no error anywhere.
        job.drain_task = asyncio.create_task(self._drain_stderr(job))
        return job

    async def _drain_stderr(self, job: EncodeJob) -> None:
        stream = job.process.stderr
        if stream is None:
            return
        async for line in stream:
            text = line.decode("utf-8", errors="replace").rstrip()
            if not text:
                continue
            job.stderr_tail.append(text)
            if len(job.stderr_tail) > STDERR_TAIL_LINES:
                job.stderr_tail.pop(0)

    async def write_frames(self, job: EncodeJob, payload: bytes) -> None:
        """Write raw frame bytes to the encoder.

        Accepts whatever chunk size arrives rather than requiring whole frames: the caller is
        streaming over
        HTTP and chunk boundaries have nothing to do with frame boundaries. The frame counter
        therefore
        tracks bytes and derives the count, which is also what makes a short final write detectable.
        """
        if job.state is not EncodeState.RUNNING:
            raise EncodeError(
                "not-running", f"encode job {job.job_id} is {job.state.value}", status=409
            )

        stdin = job.process.stdin
        if stdin is None:
            raise EncodeError("encoder-failed", "the encoder has no input stream", status=500)

        try:
            stdin.write(payload)
            # Awaiting drain is what applies backpressure: without it the renderer would race ahead
            # and buffer the whole export in memory.
            await stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as error:
            job.state = EncodeState.FAILED
            job.error = "\n".join(job.stderr_tail[-8:]) or str(error)
            raise EncodeError("encoder-failed", job.error, status=422) from error

        job.bytes_written += len(payload)

    async def finish(self, job: EncodeJob, timeout: float = 3600) -> EncodeJob:
        """Close the input and wait for the encoder to flush."""
        if job.state is EncodeState.CANCELLED:
            return job

        job.state = EncodeState.FINISHING
        stdin = job.process.stdin
        if stdin is not None:
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                stdin.close()
                await stdin.wait_closed()

        try:
            code = await asyncio.wait_for(job.process.wait(), timeout=timeout)
        except TimeoutError:
            job.process.kill()
            await job.process.wait()
            job.state = EncodeState.FAILED
            job.error = f"the encoder did not finish within {timeout}s"
            raise EncodeError("encoder-failed", job.error, status=504) from None

        if code != 0:
            job.state = EncodeState.FAILED
            job.error = "\n".join(job.stderr_tail[-8:]) or f"ffmpeg exited with code {code}"
            raise EncodeError("encoder-failed", job.error, status=422)

        job.state = EncodeState.COMPLETE
        return job

    async def cancel(self, job: EncodeJob) -> EncodeJob:
        """Abort an encode and remove the partial file.

        The partial output is deleted rather than left behind: a truncated mp4 with no moov atom
        will not
        play, and leaving one in ``renders/`` invites the user to try.
        """
        if job.state in (EncodeState.COMPLETE, EncodeState.CANCELLED):
            return job

        job.state = EncodeState.CANCELLED
        with contextlib.suppress(ProcessLookupError):
            job.process.kill()
        await job.process.wait()
        job.output.unlink(missing_ok=True)
        return job

    def forget(self, job_id: str) -> None:
        self._jobs.pop(job_id, None)

    def active(self) -> list[EncodeJob]:
        return [job for job in self._jobs.values() if job.state is EncodeState.RUNNING]
