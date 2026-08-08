"""Wire models for the sidecar HTTP API.

These mirror the TypeScript contracts in ``@nos/media`` field for field. The duplication is
deliberate and the boundary is narrow: both sides validate independently, so a mismatch surfaces
as a clear validation error at the seam rather than as an ``undefined`` three layers deep in the
renderer.

Rationals cross the wire as strings (``"30000/1001"``) so the exact frame rate survives — the
same rule the project file follows, for the same reason.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

AssetType = Literal["video", "audio", "image", "mask", "text"]


class StrictModel(BaseModel):
    """Rejects unknown fields.

    Strict on input because a typo in a field name would otherwise be silently ignored and
    present as a missing feature. This is the opposite choice from the project file, which
    tolerates unknown keys for forward compatibility — a live API between two components shipped
    together has no such requirement.
    """

    model_config = ConfigDict(extra="forbid")


class VideoStreamModel(BaseModel):
    width: int
    height: int
    frame_rate: str = Field(description='Exact rational, e.g. "30000/1001"')
    frames: int
    codec: str
    rotation: int
    pixel_aspect: float | None = None
    variable_frame_rate: bool


class AudioStreamModel(BaseModel):
    sample_rate: int
    channels: int
    codec: str
    samples: int


class ImageModel(BaseModel):
    width: int
    height: int
    codec: str


class MediaMetadataModel(BaseModel):
    asset: str
    type: AssetType
    hash: str
    size_bytes: int
    duration_seconds: float | None = None
    video: VideoStreamModel | None = None
    audio: AudioStreamModel | None = None
    image: ImageModel | None = None


class ProbeRequest(StrictModel):
    asset: str


class ProxySpecModel(StrictModel):
    kind: Literal["proxy"] = "proxy"
    short_edge: int = Field(default=1080, gt=0, le=4320)
    frame_rate: int = Field(default=30, gt=0, le=240)
    quality: int = Field(default=23, ge=0, le=51)


class FilmstripSpecModel(StrictModel):
    kind: Literal["filmstrip"] = "filmstrip"
    thumbnail_height: int = Field(default=34, gt=0, le=512)
    thumbnails_per_second: float = Field(default=1.0, gt=0, le=60)


class WaveformSpecModel(StrictModel):
    kind: Literal["waveform"] = "waveform"
    buckets_per_second: int = Field(default=100, gt=0, le=2000)
    per_channel: bool = False


DerivedSpecModel = ProxySpecModel | FilmstripSpecModel | WaveformSpecModel


class DeriveRequest(StrictModel):
    asset: str
    spec: DerivedSpecModel = Field(discriminator="kind")


class DerivedArtifactModel(BaseModel):
    kind: str
    key: str
    path: str
    """Project-relative path under ``cache/``."""
    reused: bool
    """True when the artifact was already cached, so the UI can skip a progress indicator."""


class ScanRequest(StrictModel):
    """Full directory scan, used on open and to recover from a watcher failure."""

    subtree: str | None = None


class ScanEntryModel(BaseModel):
    path: str
    is_directory: bool
    size_bytes: int
    modified_at: float | None = None


class ScanResponse(BaseModel):
    entries: list[ScanEntryModel]


class CacheStatsModel(BaseModel):
    size_bytes: int
    file_count: int


class HealthModel(BaseModel):
    status: Literal["ok"]
    version: str
    project_root: str
    ffmpeg: str
    ffprobe: str


class ErrorModel(BaseModel):
    """Structured error body.

    ``kind`` is a stable machine-readable discriminant matching the TypeScript error unions;
    ``detail`` is for humans. Returning both means the renderer can branch on the kind and still
    show something useful in a dialog.
    """

    kind: str
    detail: str


class ExportStartRequest(StrictModel):
    """Begins an encode job.

    ``expected_frames`` is advisory — it drives progress reporting only. The encoder does not
    enforce it,
    because a cancelled export legitimately writes fewer frames than planned.
    """

    job_id: str = Field(min_length=1, max_length=128)
    output: str
    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=8192)
    frame_rate: str = Field(description='Exact rational, e.g. "30000/1001"')
    codec: Literal["h264", "h265"] = "h264"
    crf: int = Field(default=19, ge=0, le=51)
    speed: Literal["veryfast", "fast", "medium", "slow"] = "medium"
    expected_frames: int = Field(default=0, ge=0)
    audio: str | None = None
    audio_codec: Literal["aac", "flac"] = "aac"
    audio_bitrate_kbps: int = Field(default=320, gt=0, le=2000)


class ExportStatusModel(BaseModel):
    job_id: str
    state: str
    frames_written: int
    expected_frames: int
    output: str
    error: str | None = None
