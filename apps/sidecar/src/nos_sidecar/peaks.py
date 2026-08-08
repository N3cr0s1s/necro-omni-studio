"""Waveform peak extraction and the ``.peaks`` file format.

Drawing an audio clip needs min/max pairs per horizontal bucket, not samples. A three-minute
stereo track is ~16 million samples; the clip on screen is a few thousand pixels wide. Reducing
once at import and storing the result is the difference between a waveform that draws instantly
and one that decodes audio on every zoom.

## File format

Little-endian throughout, since every target platform is little-endian and the renderer reads it
into a ``Float32Array`` with no conversion::

    magic        8 bytes   b"NOSPK1\\0\\0"
    version      uint32    1
    buckets/s    uint32
    channels     uint32
    bucketCount  uint32
    padding      uint32    reserved, zero
    data         float32[] channel-major, min/max interleaved per bucket

Channel-major rather than interleaved-by-bucket: the renderer draws one channel at a time, so
each channel's data is contiguous and walks memory in order.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

MAGIC = b"NOSPK1\0\0"
FORMAT_VERSION = 1
HEADER_STRUCT = struct.Struct("<8sIIIII")
HEADER_SIZE = HEADER_STRUCT.size


class PeaksError(ValueError):
    """A peaks payload is malformed."""


@dataclass(frozen=True, slots=True)
class PeakData:
    """Reduced waveform, ready to serialize."""

    buckets_per_second: int
    channels: int
    bucket_count: int
    # channel-major, two floats (min, max) per bucket
    values: list[float]


def compute_peaks(
    pcm: bytes,
    *,
    sample_rate: int,
    channels: int,
    buckets_per_second: int,
) -> PeakData:
    """Reduce interleaved float32 PCM to per-bucket min/max pairs.

    ffmpeg emits samples interleaved by channel; this walks them once, tracking a running
    min/max per channel and flushing at each bucket boundary.

    Bucket boundaries are computed from a float step and rounded, rather than by accumulating an
    integer stride. With a non-integer samples-per-bucket ratio — 44100 Hz at 100 buckets/s gives
    441, but 48000 Hz at 70 gives 685.71 — accumulating would drift and the waveform would
    gradually desynchronize from the timeline over a long clip.
    """
    if channels <= 0:
        raise PeaksError(f"channels must be positive, got {channels}")
    if sample_rate <= 0:
        raise PeaksError(f"sample rate must be positive, got {sample_rate}")
    if buckets_per_second <= 0:
        raise PeaksError(f"buckets per second must be positive, got {buckets_per_second}")

    bytes_per_sample = 4
    frame_bytes = bytes_per_sample * channels
    total_frames = len(pcm) // frame_bytes
    if total_frames == 0:
        return PeakData(buckets_per_second, channels, 0, [])

    samples_per_bucket = sample_rate / buckets_per_second
    bucket_count = max(1, round(total_frames / samples_per_bucket))

    # One (min, max) pair per bucket per channel, laid out channel-major.
    values = [0.0] * (bucket_count * channels * 2)
    unpack = struct.Struct(f"<{channels}f").unpack_from

    for bucket in range(bucket_count):
        start = round(bucket * samples_per_bucket)
        end = round((bucket + 1) * samples_per_bucket)
        if bucket == bucket_count - 1:
            end = total_frames
        end = min(end, total_frames)
        if end <= start:
            # A bucket can be empty when the source is shorter than one bucket; leave zeros so
            # the drawn waveform shows silence rather than a gap.
            continue

        minima = [float("inf")] * channels
        maxima = [float("-inf")] * channels

        for frame in range(start, end):
            offset = frame * frame_bytes
            for channel, sample in enumerate(unpack(pcm, offset)):
                if sample < minima[channel]:
                    minima[channel] = sample
                if sample > maxima[channel]:
                    maxima[channel] = sample

        for channel in range(channels):
            base = (channel * bucket_count + bucket) * 2
            values[base] = _clamp(minima[channel])
            values[base + 1] = _clamp(maxima[channel])

    return PeakData(buckets_per_second, channels, bucket_count, values)


def _clamp(value: float) -> float:
    """Clamp to [-1, 1].

    Float PCM can legitimately exceed unity — material mastered hot, or an intersample peak after
    resampling. The renderer treats the range as normalized, so clamping here keeps a hot track
    from drawing outside its clip body.
    """
    if value != value or value == float("inf") or value == float("-inf"):
        # NaN or infinity from a corrupt decode; silence is the safe interpretation.
        return 0.0
    return max(-1.0, min(1.0, value))


def encode_peaks(data: PeakData) -> bytes:
    """Serialize peak data to the ``.peaks`` format."""
    header = HEADER_STRUCT.pack(
        MAGIC,
        FORMAT_VERSION,
        data.buckets_per_second,
        data.channels,
        data.bucket_count,
        0,
    )
    expected = data.bucket_count * data.channels * 2
    if len(data.values) != expected:
        raise PeaksError(f"expected {expected} values, got {len(data.values)}")
    body = struct.pack(f"<{len(data.values)}f", *data.values)
    return header + body


def decode_peaks(payload: bytes) -> PeakData:
    """Parse a ``.peaks`` payload.

    Used by the sidecar's own tests and by any future tooling; the renderer parses the same
    layout in TypeScript. Every field is checked because a truncated cache file is an expected
    condition, not a defect — a crash mid-write leaves one.
    """
    if len(payload) < HEADER_SIZE:
        raise PeaksError("payload is shorter than the header")
    magic, version, buckets_per_second, channels, bucket_count, _reserved = (
        HEADER_STRUCT.unpack_from(payload)
    )
    if magic != MAGIC:
        raise PeaksError("not a peaks file")
    if version != FORMAT_VERSION:
        raise PeaksError(f"unsupported peaks version {version}")

    expected = bucket_count * channels * 2
    body = payload[HEADER_SIZE:]
    if len(body) != expected * 4:
        raise PeaksError(f"expected {expected * 4} bytes of peak data, got {len(body)}")

    values = list(struct.unpack(f"<{expected}f", body)) if expected else []
    return PeakData(buckets_per_second, channels, bucket_count, values)
