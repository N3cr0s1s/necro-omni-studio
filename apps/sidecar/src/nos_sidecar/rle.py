"""Run-length coding for binary masks.

The wire format is COCO's and must match ``packages/masks/src/codec/rle.ts`` byte for byte:
**column-major**, alternating run lengths, always starting with a run of zeros. The two
implementations are checked against one shared fixture (``tests/test_rle.py`` and the TypeScript
codec test both encode the same picture), because a silent disagreement here produces masks that
decode into a transposed or inverted shape — visible only as a wrong-looking render, with nothing
in any log.
"""

from __future__ import annotations

from collections.abc import Sequence


def encode_rle(bitmap: Sequence[int], width: int, height: int) -> list[int]:
    """Encode a row-major bitmap. Any non-zero value counts as inside the mask."""
    if len(bitmap) != width * height:
        raise ValueError(f"bitmap of {len(bitmap)} does not match {width}x{height}")

    counts: list[int] = []
    # Always starts with a zero run, even an empty one. Without that convention the array's parity
    # would carry the first pixel's value, and a decoder reading a foreign mask would invert it.
    current = 0
    run = 0

    for column in range(width):
        for row in range(height):
            value = 1 if bitmap[row * width + column] else 0
            if value == current:
                run += 1
            else:
                counts.append(run)
                current = value
                run = 1

    counts.append(run)
    return counts


def decode_rle(counts: Sequence[int], width: int, height: int) -> bytearray:
    """Decode to a row-major bitmap of 0/1 bytes."""
    bitmap = bytearray(width * height)
    value = 0
    index = 0

    for run in counts:
        if not isinstance(run, int) or run < 0:
            raise ValueError(f"run length {run!r} is not a non-negative integer")
        if value == 1:
            for offset in range(run):
                position = index + offset
                if position >= width * height:
                    break
                # Column-major on the wire, row-major in memory.
                column, row = divmod(position, height)
                bitmap[row * width + column] = 1
        index += run
        value = 1 - value

    return bitmap


def mask_area(counts: Sequence[int]) -> int:
    """Pixels inside the mask, without decoding it."""
    return sum(counts[1::2])


def is_well_formed(counts: Sequence[int], width: int, height: int) -> bool:
    """Whether the runs cover exactly the frame they claim to."""
    return (
        all(isinstance(run, int) and run >= 0 for run in counts) and sum(counts) == width * height
    )


def serialize_frame(counts: Sequence[int], width: int, height: int) -> str:
    """The on-disk form: dimensions, then the runs. Readable in a terminal on purpose."""
    return f"{width} {height}\n{','.join(str(run) for run in counts)}\n"
