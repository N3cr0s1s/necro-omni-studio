"""Media operations: probing, derived artifacts and directory scanning.

The service owns the composition — validate the path, hash the content, decide whether a cached
artifact is still valid, run ffmpeg if not. Endpoints stay thin request/response adapters, which
keeps this logic testable without HTTP.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from . import ffmpeg, peaks
from .hashing import HashCache
from .models import (
    AudioStreamModel,
    DerivedArtifactModel,
    DerivedSpecModel,
    FilmstripCoverageModel,
    FilmstripSpecModel,
    ImageModel,
    MediaMetadataModel,
    ProxySpecModel,
    ScanEntryModel,
    StillModel,
    VideoStreamModel,
    WaveformSpecModel,
)
from .paths import CACHE_FOLDER, PathError, is_cache_path, resolve_in_project, to_relative

# Mirrors the TypeScript classification. Kept in sync by the shared-vocabulary test.
VIDEO_EXTENSIONS = frozenset(
    {"mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg", "ts", "mts", "m2ts", "wmv"}
)
AUDIO_EXTENSIONS = frozenset({"flac", "wav", "aiff", "aif", "mp3", "m4a", "aac", "ogg", "opus"})
IMAGE_EXTENSIONS = frozenset(
    {"png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "exr", "tga", "image"}
)
TEXT_EXTENSIONS = frozenset({"md", "markdown", "txt", "srt", "vtt", "json"})

IGNORED_NAMES = frozenset(
    {".DS_Store", "Thumbs.db", "desktop.ini", ".gitkeep", "project.recovery.json"}
)
IGNORED_PREFIXES = ("~$", ".#")
IGNORED_SUFFIXES = (".tmp", ".part", ".crdownload", ".swp")

# Sample rate used for peak extraction. Well below source rates: peaks resolve to a few hundred
# buckets per second at most, so decoding at full rate would be wasted work.
PEAK_SAMPLE_RATE = 16_000

DERIVED_EXTENSIONS = {"proxy": "mp4", "filmstrip": "jpg", "waveform": "peaks"}


class MediaError(Exception):
    """A media operation failed in a way the renderer should handle, not a defect."""

    def __init__(self, kind: str, detail: str, *, status: int = 400) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.status = status


def classify(relative: str) -> str | None:
    """Best-effort asset type from the extension, matching the TypeScript rules."""
    name = relative.rsplit("/", 1)[-1]
    dot = name.rfind(".")
    if dot <= 0:
        return None
    extension = name[dot + 1 :].lower()
    if extension in VIDEO_EXTENSIONS:
        return "video"
    if extension in AUDIO_EXTENSIONS:
        return "audio"
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension in TEXT_EXTENSIONS:
        return "text"
    return None


def is_ignored(relative: str) -> bool:
    name = relative.rsplit("/", 1)[-1]
    if name in IGNORED_NAMES:
        return True
    if name.startswith(IGNORED_PREFIXES):
        return True
    return name.lower().endswith(IGNORED_SUFFIXES)


@dataclass(frozen=True, slots=True)
class Probe:
    """Parsed probe result, before it becomes a wire model."""

    metadata: MediaMetadataModel


class MediaService:
    """Media operations rooted at one project folder."""

    def __init__(self, root: Path, tooling: ffmpeg.Tooling) -> None:
        self._root = root
        self._tooling = tooling
        self._hashes = HashCache(root)
        # Coalesces concurrent requests for the same derivation. The browser and the timeline
        # both ask for the same filmstrip on load; without this they would each spawn ffmpeg and
        # race to write the same output file.
        self._in_flight: dict[str, asyncio.Task[DerivedArtifactModel]] = {}

    @property
    def root(self) -> Path:
        return self._root

    def resolve(self, asset: str) -> Path:
        try:
            return resolve_in_project(self._root, asset)
        except PathError as error:
            raise MediaError("invalid-path", str(error), status=400) from error

    def require_file(self, asset: str) -> Path:
        path = self.resolve(asset)
        if not path.exists():
            raise MediaError("not-found", f"{asset} does not exist", status=404)
        if not path.is_file():
            raise MediaError("not-found", f"{asset} is not a file", status=404)
        return path

    def content_hash(self, asset: str) -> str:
        path = self.require_file(asset)
        digest = self._hashes.get(asset, path)
        self._hashes.flush()
        return digest

    async def probe(self, asset: str) -> MediaMetadataModel:
        """Read stream metadata for an asset."""
        path = self.require_file(asset)
        declared_type = classify(asset)

        if declared_type == "text":
            # No point invoking ffprobe on markdown; the browser only needs size and hash.
            return MediaMetadataModel(
                asset=asset,
                type="text",
                hash=self._hashes.get(asset, path),
                size_bytes=path.stat().st_size,
            )

        try:
            stdout, _ = await ffmpeg.run(
                ffmpeg.probe_command(self._tooling.ffprobe, path), timeout=60
            )
        except ffmpeg.FfmpegError as error:
            raise MediaError("unsupported", f"{asset}: {error}", status=422) from error

        parsed = ffmpeg.parse_probe_output(stdout)
        streams = [s for s in parsed.get("streams", []) if isinstance(s, dict)]
        container = parsed.get("format") or {}

        video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

        duration = _parse_float(container.get("duration"))
        size_bytes = _parse_int(container.get("size")) or path.stat().st_size

        video_model: VideoStreamModel | None = None
        image_model: ImageModel | None = None

        if video_stream is not None:
            rate = ffmpeg.parse_rational(video_stream.get("r_frame_rate"))
            is_still = declared_type == "image" or rate is None
            if is_still:
                image_model = ImageModel(
                    width=_parse_int(video_stream.get("width")) or 0,
                    height=_parse_int(video_stream.get("height")) or 0,
                    codec=str(video_stream.get("codec_name") or "unknown"),
                )
            else:
                assert rate is not None
                video_model = VideoStreamModel(
                    width=_parse_int(video_stream.get("width")) or 0,
                    height=_parse_int(video_stream.get("height")) or 0,
                    frame_rate=f"{rate.numerator}/{rate.denominator}",
                    frames=_frame_count(video_stream, rate, duration),
                    codec=str(video_stream.get("codec_name") or "unknown"),
                    rotation=ffmpeg.stream_rotation(video_stream),
                    pixel_aspect=_parse_aspect(video_stream.get("sample_aspect_ratio")),
                    variable_frame_rate=ffmpeg.is_variable_frame_rate(video_stream),
                )

        audio_model: AudioStreamModel | None = None
        if audio_stream is not None:
            sample_rate = _parse_int(audio_stream.get("sample_rate")) or 0
            audio_model = AudioStreamModel(
                sample_rate=sample_rate,
                channels=_parse_int(audio_stream.get("channels")) or 0,
                codec=str(audio_stream.get("codec_name") or "unknown"),
                samples=_sample_count(audio_stream, sample_rate, duration),
            )

        # What the file *is*, for the UI, decided by what it actually contains rather than by its
        # extension: a `.mov` holding only an audio stream is an audio asset.
        if video_model is not None:
            resolved_type = "video"
        elif image_model is not None:
            resolved_type = "image"
        elif audio_model is not None:
            resolved_type = "audio"
        else:
            raise MediaError("unsupported", f"{asset} contains no usable stream", status=422)

        return MediaMetadataModel(
            asset=asset,
            type=resolved_type,  # type: ignore[arg-type]
            hash=self._hashes.get(asset, path),
            size_bytes=size_bytes,
            duration_seconds=duration,
            video=video_model,
            audio=audio_model,
            image=image_model,
        )

    def cache_key(self, digest: str, spec: DerivedSpecModel) -> str:
        return f"{spec.kind}_{_describe_spec(spec)}_{digest[:16]}"

    async def still(self, asset: str, seconds: float, destination: str) -> StillModel:
        """Write the frame at ``seconds`` of a video to ``destination`` inside the project.

        Idempotent by path. The caller names the file after the source and the frame, so asking
        twice for the same frame is the normal case — a user stepping back and forth between two
        candidate frames would otherwise pay for ffmpeg each time.

        The write goes to a temporary neighbour and is renamed into place. The project folder is
        watched, and a watcher that sees a half-written PNG will hand the browser a file it cannot
        decode; a rename is atomic on both target platforms, so the file appears whole or not at
        all.
        """
        source = self.require_file(asset)
        target = self.resolve(destination)
        if is_cache_path(destination):
            # A grabbed frame under `cache/` would be deleted by Clear cache and would stop a run
            # from reproducing. Refused here rather than in the UI: this is the invariant's home.
            raise MediaError(
                "invalid-path",
                f"{destination} is under {CACHE_FOLDER}, which is disposable",
                status=400,
            )

        if target.exists() and target.stat().st_size > 0:
            width, height = await self._image_size(destination)
            return StillModel(asset=destination, width=width, height=height, reused=True)

        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(f"{target.name}.partial")
        try:
            await ffmpeg.run(
                ffmpeg.still_command(self._tooling.ffmpeg, source, partial, seconds=seconds),
                timeout=120,
            )
        except ffmpeg.FfmpegError as error:
            with contextlib.suppress(OSError):
                partial.unlink()
            raise MediaError("failed", f"{asset}: {error}", status=422) from error

        if not partial.exists() or partial.stat().st_size == 0:
            with contextlib.suppress(OSError):
                partial.unlink()
            # ffmpeg exits 0 having written nothing when the timestamp is past the end of the
            # source, which is reachable by asking for the last frame of a clip.
            raise MediaError(
                "failed",
                f"{asset}: no frame at {seconds:.3f}s",
                status=422,
            )

        partial.replace(target)
        width, height = await self._image_size(destination)
        return StillModel(asset=destination, width=width, height=height, reused=False)

    async def _image_size(self, asset: str) -> tuple[int, int]:
        probed = await self.probe(asset)
        image = probed.image
        return (image.width, image.height) if image is not None else (0, 0)

    def derived_relative(self, digest: str, spec: DerivedSpecModel) -> str:
        return f"{CACHE_FOLDER}/{self.cache_key(digest, spec)}.{DERIVED_EXTENSIONS[spec.kind]}"

    async def derive(self, asset: str, spec: DerivedSpecModel) -> DerivedArtifactModel:
        """Produce a derived artifact, reusing a cached one when possible.

        Concurrent calls for the same key share one task rather than racing. Two ffmpeg processes
        writing the same output path would otherwise produce a truncated or interleaved file, and
        the failure would be intermittent and load-dependent — the worst kind to debug.
        """
        path = self.require_file(asset)
        digest = self._hashes.get(asset, path)
        self._hashes.flush()
        relative = self.derived_relative(digest, spec)
        absolute = self._root / relative

        if absolute.exists() and absolute.stat().st_size > 0:
            coverage = self._read_coverage(absolute) if spec.kind == "filmstrip" else None
            # A filmstrip without its coverage is unusable — the renderer cannot place it — so a
            # cache entry written before the sidecar recorded coverage is re-produced rather than
            # returned. One regeneration per stale entry keeps a single code path downstream.
            if spec.kind != "filmstrip" or coverage is not None:
                return DerivedArtifactModel(
                    kind=spec.kind,
                    key=self.cache_key(digest, spec),
                    path=relative,
                    reused=True,
                    filmstrip=coverage,
                )

        existing = self._in_flight.get(relative)
        if existing is not None:
            return await asyncio.shield(existing)

        task = asyncio.create_task(self._produce(asset, path, spec, digest, relative, absolute))
        self._in_flight[relative] = task
        try:
            return await task
        finally:
            self._in_flight.pop(relative, None)

    async def _produce(
        self,
        asset: str,
        source: Path,
        spec: DerivedSpecModel,
        digest: str,
        relative: str,
        destination: Path,
    ) -> DerivedArtifactModel:
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temporary sibling and rename: a cancelled or crashed render must not leave a
        # partial file that `exists()` would later treat as a valid cache hit.
        #
        # The real suffix has to be preserved. ffmpeg infers the output container from the
        # extension, so a name ending in `.partial` fails with "unable to find a suitable output
        # format" — and the dot prefix keeps it hidden and out of the scan either way.
        temporary = destination.with_name(f".{destination.stem}.partial{destination.suffix}")

        coverage: FilmstripCoverageModel | None = None
        try:
            if isinstance(spec, ProxySpecModel):
                await ffmpeg.run(
                    ffmpeg.proxy_command(
                        self._tooling.ffmpeg,
                        source,
                        temporary,
                        short_edge=spec.short_edge,
                        frame_rate=spec.frame_rate,
                        quality=spec.quality,
                    ),
                    timeout=3600,
                )
            elif isinstance(spec, FilmstripSpecModel):
                coverage = await self._produce_filmstrip(source, temporary, spec)
            elif isinstance(spec, WaveformSpecModel):
                await self._produce_waveform(source, temporary, spec)
            else:  # pragma: no cover - the union is closed
                raise MediaError("unsupported", f"unknown derivation {spec!r}", status=400)

            temporary.replace(destination)
            if coverage is not None:
                self._write_coverage(destination, coverage)
        except ffmpeg.FfmpegError as error:
            temporary.unlink(missing_ok=True)
            raise MediaError("derivation-failed", f"{asset}: {error}", status=422) from error
        except BaseException:
            # Includes cancellation: clean up so the next attempt starts fresh.
            temporary.unlink(missing_ok=True)
            raise

        return DerivedArtifactModel(
            kind=spec.kind,
            key=self.cache_key(digest, spec),
            path=relative,
            reused=False,
            filmstrip=coverage,
        )

    @staticmethod
    def _coverage_path(artifact: Path) -> Path:
        # A dotted sibling rather than a field in a shared index: the description lives and dies
        # with the file it describes, so deleting a cache entry by hand cannot leave a stale record
        # behind, and the folder stays free of anything the scan would show.
        return artifact.with_name(f".{artifact.name}.meta.json")

    def _read_coverage(self, artifact: Path) -> FilmstripCoverageModel | None:
        try:
            return FilmstripCoverageModel.model_validate_json(
                self._coverage_path(artifact).read_bytes()
            )
        except (OSError, ValueError):
            # Missing or corrupt: treated as absent, which re-produces the artifact. Never fatal —
            # a bad byte in a cache description must not make the project unopenable.
            return None

    def _write_coverage(self, artifact: Path, coverage: FilmstripCoverageModel) -> None:
        # The strip itself is already written; losing its description costs one regeneration next
        # time, which is not worth failing the request over.
        with contextlib.suppress(OSError):
            self._coverage_path(artifact).write_text(coverage.model_dump_json(), encoding="utf-8")

    async def _produce_filmstrip(
        self, source: Path, destination: Path, spec: FilmstripSpecModel
    ) -> FilmstripCoverageModel:
        """Render the filmstrip as a single tiled image.

        The column count must be computed from the duration, because ``tile`` needs a fixed grid
        up front. Without a duration ffmpeg would emit multiple images and only the first would be
        kept, silently truncating the strip.
        """
        duration = await self._duration_seconds(source)
        thumbnails = max(1, round(duration * spec.thumbnails_per_second)) if duration else 1
        # Cap the strip: a 20-minute source at 1/s is 1200 tiles, which exceeds what a single
        # texture can hold on modest hardware. Beyond the cap the sampling rate is reduced
        # instead, so the strip still spans the whole clip.
        max_columns = 900
        if thumbnails > max_columns:
            rate = max_columns / duration if duration else spec.thumbnails_per_second
            thumbnails = max_columns
        else:
            rate = spec.thumbnails_per_second

        await ffmpeg.run(
            ffmpeg.filmstrip_command(
                self._tooling.ffmpeg,
                source,
                destination,
                thumbnail_height=spec.thumbnail_height,
                thumbnails_per_second=rate,
                columns=thumbnails,
            ),
            timeout=1800,
        )

        return FilmstripCoverageModel(
            duration_seconds=duration, columns=thumbnails, thumbnails_per_second=rate
        )

    async def _produce_waveform(
        self, source: Path, destination: Path, spec: WaveformSpecModel
    ) -> None:
        probe_stdout, _ = await ffmpeg.run(
            ffmpeg.probe_command(self._tooling.ffprobe, source), timeout=60
        )
        parsed = ffmpeg.parse_probe_output(probe_stdout)
        audio_stream = next(
            (
                s
                for s in parsed.get("streams", [])
                if isinstance(s, dict) and s.get("codec_type") == "audio"
            ),
            None,
        )
        if audio_stream is None:
            raise MediaError("unsupported", f"{source.name} has no audio stream", status=422)

        source_channels = _parse_int(audio_stream.get("channels")) or 1
        channels = source_channels if spec.per_channel else 1

        pcm, _ = await ffmpeg.run(
            ffmpeg.waveform_pcm_command(
                self._tooling.ffmpeg, source, sample_rate=PEAK_SAMPLE_RATE, channels=channels
            ),
            timeout=1800,
        )
        data = peaks.compute_peaks(
            pcm,
            sample_rate=PEAK_SAMPLE_RATE,
            channels=channels,
            buckets_per_second=spec.buckets_per_second,
        )
        destination.write_bytes(peaks.encode_peaks(data))

    async def _duration_seconds(self, source: Path) -> float:
        stdout, _ = await ffmpeg.run(
            ffmpeg.probe_command(self._tooling.ffprobe, source), timeout=60
        )
        parsed = ffmpeg.parse_probe_output(stdout)
        return _parse_float((parsed.get("format") or {}).get("duration")) or 0.0

    def scan(self, subtree: str | None = None) -> list[ScanEntryModel]:
        """Walk the project folder.

        Cache *contents* are skipped but the folder itself is reported, because the spec requires
        the browser to show it with its size. Ignored droppings are filtered here so every caller
        sees the same view of the project.
        """
        base = self._root if subtree is None else self.resolve(subtree)
        if not base.exists():
            return []

        entries: list[ScanEntryModel] = []
        root_resolved = self._root.resolve()

        for path in sorted(base.rglob("*")):
            try:
                relative = to_relative(root_resolved, path)
            except PathError:
                # A symlink pointing outside the project. Skipped rather than reported: the
                # browser must not offer a path the rest of the system will refuse to open.
                continue

            if is_ignored(relative):
                continue
            is_directory = path.is_dir()
            if is_cache_path(relative) and relative != CACHE_FOLDER:
                continue

            try:
                stat = path.stat()
            except OSError:
                # Vanished between listing and stat — a generator cleaning up mid-scan.
                continue

            entries.append(
                ScanEntryModel(
                    path=relative,
                    is_directory=is_directory,
                    size_bytes=0 if is_directory else stat.st_size,
                    modified_at=stat.st_mtime,
                )
            )

        return entries

    def cache_stats(self) -> tuple[int, int]:
        cache = self._root / CACHE_FOLDER
        if not cache.exists():
            return (0, 0)
        total = 0
        count = 0
        for path in cache.rglob("*"):
            if path.is_file():
                try:
                    total += path.stat().st_size
                except OSError:
                    continue
                count += 1
        return (total, count)

    def clear_cache(self) -> None:
        """Delete every derived artifact.

        Safe by construction — everything under ``cache/`` is regenerable, which is exactly why
        the spec marks this folder disposable and `generated/` not.
        """
        cache = self._root / CACHE_FOLDER
        if not cache.exists():
            return
        for path in sorted(cache.rglob("*"), reverse=True):
            try:
                if path.is_file() or path.is_symlink():
                    path.unlink()
                else:
                    path.rmdir()
            except OSError:
                continue


def _describe_spec(spec: DerivedSpecModel) -> str:
    if isinstance(spec, ProxySpecModel):
        return f"{spec.short_edge}p{spec.frame_rate}q{spec.quality}"
    if isinstance(spec, FilmstripSpecModel):
        rate = spec.thumbnails_per_second
        rendered = str(int(rate)) if float(rate).is_integer() else str(rate)
        return f"h{spec.thumbnail_height}n{rendered}"
    return f"b{spec.buckets_per_second}{'multi' if spec.per_channel else 'mono'}"


def _parse_int(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _parse_float(value: object) -> float | None:
    try:
        parsed = float(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None


def _parse_aspect(value: object) -> float | None:
    """Parse ffprobe's ``sample_aspect_ratio``, ignoring the square-pixel case."""
    raw = str(value) if value is not None else ""
    if not raw or raw in {"0:1", "1:1", "N/A"}:
        return None
    try:
        numerator, _, denominator = raw.partition(":")
        ratio = Fraction(int(numerator), int(denominator))
    except (ValueError, ZeroDivisionError):
        return None
    return float(ratio) if ratio > 0 else None


def _frame_count(stream: dict, rate: Fraction, duration: float | None) -> int:
    """Frame count, preferring the container's own tally.

    ``nb_frames`` is exact when present but many containers omit it, so the fallback derives the
    count from duration × rate. Derivation is a last resort because a container duration is
    frequently a rounded value.
    """
    declared = _parse_int(stream.get("nb_frames"))
    if declared is not None and declared > 0:
        return declared
    stream_duration = _parse_float(stream.get("duration")) or duration
    if stream_duration is None:
        return 0
    return max(0, round(stream_duration * float(rate)))


def _sample_count(stream: dict, sample_rate: int, duration: float | None) -> int:
    declared = _parse_int(stream.get("nb_samples"))
    if declared is not None and declared > 0:
        return declared
    stream_duration = _parse_float(stream.get("duration")) or duration
    if stream_duration is None or sample_rate <= 0:
        return 0
    return max(0, round(stream_duration * sample_rate))
