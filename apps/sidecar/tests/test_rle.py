"""Run-length coding, checked against the TypeScript codec's fixture.

The two implementations must agree exactly. ``packages/masks/src/codec/rle.test.ts`` encodes the
same pictures and asserts the same counts, so a change to either side that breaks the agreement
fails here rather than showing up as a mask that renders transposed with nothing in any log.
"""

from __future__ import annotations

import pytest

from nos_sidecar.rle import decode_rle, encode_rle, is_well_formed, mask_area, serialize_frame


def bitmap_of(rows: list[str]) -> tuple[list[int], int, int]:
    """A bitmap from an ASCII picture, so a test reads as the shape it asserts."""
    height = len(rows)
    width = len(rows[0]) if rows else 0
    flat = [1 if cell == "#" else 0 for row in rows for cell in row]
    return flat, width, height


def picture_of(bitmap: bytearray, width: int, height: int) -> list[str]:
    return [
        "".join("#" if bitmap[y * width + x] else "." for x in range(width)) for y in range(height)
    ]


def test_encodes_column_major_like_coco() -> None:
    # The shared fixture. The TypeScript test asserts these exact counts for this exact picture:
    # column 0 is two ones, column 1 is two zeros.
    flat, width, height = bitmap_of(["#.", "#."])
    assert encode_rle(flat, width, height) == [0, 2, 2]


def test_always_starts_with_a_zero_run() -> None:
    flat, width, height = bitmap_of(["##", "##"])
    assert encode_rle(flat, width, height)[0] == 0


def test_round_trips_a_picture() -> None:
    rows = ["..##..", ".####.", ".####.", "..##.."]
    flat, width, height = bitmap_of(rows)
    assert (
        picture_of(decode_rle(encode_rle(flat, width, height), width, height), width, height)
        == rows
    )


def test_round_trips_a_non_square_frame() -> None:
    # The classic failure: encoding column-major and decoding row-major agrees on every square and
    # transposes everything else.
    rows = ["#..", ".#.", "..#", "#.#"]
    flat, width, height = bitmap_of(rows)
    assert (
        picture_of(decode_rle(encode_rle(flat, width, height), width, height), width, height)
        == rows
    )


def test_counts_sum_to_the_frame_area() -> None:
    flat, width, height = bitmap_of(["#.#.", ".##.", "...."])
    assert sum(encode_rle(flat, width, height)) == width * height


def test_reports_area_without_decoding() -> None:
    flat, width, height = bitmap_of(["#.#.", ".##."])
    assert mask_area(encode_rle(flat, width, height)) == 4


def test_treats_any_non_zero_as_inside() -> None:
    # Engines emit 255, not 1.
    assert mask_area(encode_rle([255, 0, 1, 0], 2, 2)) == 2


def test_rejects_a_bitmap_that_does_not_match_its_dimensions() -> None:
    with pytest.raises(ValueError):
        encode_rle([0] * 5, 2, 2)


def test_rejects_a_negative_run() -> None:
    with pytest.raises(ValueError):
        decode_rle([0, -1], 2, 2)


def test_does_not_write_past_the_frame_when_counts_overrun() -> None:
    # A truncated or foreign file must not corrupt memory.
    assert list(decode_rle([0, 1000], 2, 2)) == [1, 1, 1, 1]


def test_leaves_the_rest_zero_when_counts_fall_short() -> None:
    assert list(decode_rle([0, 1], 2, 2)) == [1, 0, 0, 0]


def test_well_formedness_matches_the_frame() -> None:
    assert is_well_formed([0, 2, 2], 2, 2)
    assert not is_well_formed([0, 2], 2, 2)
    assert not is_well_formed([0, 2, 2, 1], 2, 2)


def test_file_form_matches_the_typescript_writer() -> None:
    # `packages/masks/src/cache/mask-cache.test.ts` asserts this exact string for the same frame.
    assert serialize_frame([0, 8], 4, 2) == "4 2\n0,8\n"
