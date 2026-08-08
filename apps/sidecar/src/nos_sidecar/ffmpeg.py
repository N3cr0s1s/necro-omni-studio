"""ffmpeg and ffprobe process wrappers.

The sidecar owns every ffmpeg invocation in the system. Keeping them here rather than inline at
the endpoints means the argument construction is testable without running a subprocess, and the
renderer never learns that ffmpeg exists — it asks for a proxy, not for a transcode.

All commands are built as argument *lists* and executed without a shell, so a filename
containing a quote, a semicolon or a newline cannot become a command injection.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path


class FfmpegError(RuntimeError):
    """An ffmpeg or ffprobe invocation failed."""

    def __init__(self, message: str, *, stderr: str = "") -> None:
        super().__init__(message)
        self.stderr = stderr


@dataclass(frozen=True, slots=True)
class Tooling:
    """Resolved paths to the external binaries."""

    ffmpeg: str
    ffprobe: str

    @staticmethod
    def discover() -> Tooling:
        """Locate the binaries on PATH.

        Failing loudly at startup is deliberate: a sidecar that starts without ffmpeg would
        accept requests and fail every one of them, which reads to the user as "importing is
        broken" rather than "a dependency is missing".
        """
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        missing = [
            name for name, found in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)) if found is None
        ]
        if missing:
            raise FfmpegError(f"required binaries not found on PATH: {', '.join(missing)}")
        assert ffmpeg is not None and ffprobe is not None
        return Tooling(ffmpeg=ffmpeg, ffprobe=ffprobe)


async def run(command: list[str], *, timeout: float | None = None) -> tuple[bytes, str]:
    """Run a command, returning stdout and stderr.

    stderr is captured rather than streamed because ffmpeg writes progress there; the caller
    decides whether it is diagnostic output or an error message.
    """
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise FfmpegError(f"{command[0]} timed out after {timeout}s") from None

    decoded_stderr = stderr.decode("utf-8", errors="replace")
    if process.returncode != 0:
        raise FfmpegError(
            f"{Path(command[0]).name} exited with code {process.returncode}",
            stderr=decoded_stderr,
        )
    return stdout, decoded_stderr


def probe_command(ffprobe: str, source: Path) -> list[str]:
    """Build the ffprobe command for full stream metadata."""
    return [
        ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(source),
    ]


def parse_rational(raw: str | None) -> Fraction | None:
    """Parse ffprobe's ``30000/1001`` rate strings.

    ffprobe reports ``0/0`` for streams with no meaningful rate (a still image, an attached
    cover). That is not an error, so it maps to ``None`` rather than raising.
    """
    if not raw:
        return None
    try:
        value = Fraction(raw)
    except (ValueError, ZeroDivisionError):
        return None
    return value if value > 0 else None


def parse_probe_output(payload: bytes) -> dict:
    """Decode ffprobe JSON output."""
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as error:
        raise FfmpegError(f"ffprobe returned invalid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise FfmpegError("ffprobe returned an unexpected shape")
    return parsed


def stream_rotation(stream: dict) -> int:
    """Extract display rotation in degrees, normalized to 0/90/180/270.

    Rotation appears in two places depending on the container and the ffmpeg version: a
    ``rotate`` tag, or a display-matrix side-data entry with a negative angle. Phone footage
    routinely relies on this, and ignoring it renders the clip sideways, so both are read.
    """
    tags = stream.get("tags") or {}
    raw = tags.get("rotate")
    angle = 0.0
    if raw is not None:
        try:
            angle = float(raw)
        except (TypeError, ValueError):
            angle = 0.0

    if angle == 0.0:
        for entry in stream.get("side_data_list") or []:
            if not isinstance(entry, dict):
                continue
            if "rotation" in entry:
                try:
                    # The display matrix reports the rotation to *undo*, hence the negation.
                    angle = -float(entry["rotation"])
                except (TypeError, ValueError):
                    continue
                break

    return int(angle) % 360


def is_variable_frame_rate(stream: dict) -> bool:
    """Detect a stream with no constant frame rate.

    ffprobe exposes both the average rate over the file and the nominal real base frame rate.
    When they disagree meaningfully the source is variable, and frame-exact editing against it
    is not meaningful — the importer transcodes instead of pretending an index maps to a frame.
    """
    average = parse_rational(stream.get("avg_frame_rate"))
    nominal = parse_rational(stream.get("r_frame_rate"))
    if average is None or nominal is None:
        return False
    if nominal == average:
        return False
    # A 1% tolerance: container rounding routinely produces tiny disagreements on files that
    # are genuinely constant-rate.
    return abs(float(nominal) - float(average)) / float(average) > 0.01


def proxy_command(
    ffmpeg: str,
    source: Path,
    destination: Path,
    *,
    short_edge: int,
    frame_rate: int,
    quality: int,
) -> list[str]:
    """Build the proxy transcode command.

    ``short_edge`` is the ``p`` number: 1080 means 1080 lines for landscape material and 1080
    columns for portrait, matching the broadcast convention. The filter therefore constrains
    whichever dimension is smaller and lets the other follow the source aspect, so vertical
    footage stays vertical instead of being letterboxed into a landscape frame.

    Scaling uses ``-2`` on the free edge so the result stays even, which H.264 requires with
    4:2:0 chroma.

    ``faststart`` matters for playback: without it the index sits at the end of the file, and
    the preview stalls on the first seek of every proxy.
    """
    scale = (
        f"scale=if(gte(iw\\,ih)\\,-2\\,{short_edge}):if(gte(iw\\,ih)\\,{short_edge}\\,-2)"
        ":flags=bicubic"
    )
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        str(source),
        "-vf",
        scale,
        "-r",
        str(frame_rate),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(quality),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        # Proxies are for picture only; audio is mixed from the original so the proxy stays
        # small and transcoding never colours the sound.
        "-an",
        "-progress",
        "pipe:2",
        str(destination),
    ]


def filmstrip_command(
    ffmpeg: str,
    source: Path,
    destination: Path,
    *,
    thumbnail_height: int,
    thumbnails_per_second: float,
    columns: int,
) -> list[str]:
    """Build the filmstrip tile command.

    One image holding every thumbnail rather than a file per frame: a clip body draws its whole
    strip from a single texture, and a few hundred separate HTTP requests per clip would not
    hold the 16 ms interaction budget.
    """
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        str(source),
        "-vf",
        f"fps={thumbnails_per_second},scale=-2:{thumbnail_height},tile={columns}x1",
        "-frames:v",
        "1",
        "-q:v",
        "4",
        str(destination),
    ]


def still_command(ffmpeg: str, source: Path, destination: Path, *, seconds: float) -> list[str]:
    """Build the command that lifts one frame out of a video as a PNG.

    ``-ss`` before ``-i`` so ffmpeg seeks rather than decoding up to the timestamp: on a long
    source the difference is a second against a minute, and this runs while the user waits with a
    generator panel open.

    ``-accurate_seek`` because the fast seek lands on the preceding keyframe otherwise, and the
    frame a user picked is the frame they were looking at — being two seconds early is exactly the
    kind of "close enough" that makes an image-to-video result inexplicable.

    PNG rather than JPEG: this is a generator *input*, and re-compressing a frame that is about to
    condition a diffusion model adds artefacts for no saving that matters at one image. The muxer is
    named explicitly rather than inferred from the extension, because the destination is a
    ``.partial`` file — the whole point of which is that nothing mistakes it for a finished image.
    """
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-accurate_seek",
        "-ss",
        f"{max(0.0, seconds):.6f}",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-c:v",
        "png",
        str(destination),
    ]


def waveform_pcm_command(
    ffmpeg: str, source: Path, *, sample_rate: int, channels: int
) -> list[str]:
    """Build a command that streams raw float PCM to stdout for peak extraction.

    Float samples rather than 16-bit integers: peaks are computed and stored normalized, and
    starting from float avoids a quantization step that would clip material mastered hot.
    """
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-i",
        str(source),
        "-vn",
        "-ac",
        str(channels),
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "pipe:1",
    ]


def parse_progress(stderr_line: str) -> float | None:
    """Extract a microsecond timestamp from an ffmpeg ``-progress`` line.

    Returns seconds elapsed in the output, or ``None`` for lines that carry no position. The
    caller divides by the known duration to produce a fraction; ffmpeg cannot do that itself
    because it does not always know the duration up front.
    """
    key, _, value = stderr_line.partition("=")
    if key.strip() != "out_time_us":
        return None
    try:
        return int(value.strip()) / 1_000_000
    except ValueError:
        return None
