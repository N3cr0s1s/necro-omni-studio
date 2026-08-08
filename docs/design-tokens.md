# Design tokens

Extracted from the Claude Design project `Video Editor Mockups.dc.html`
(8 screens at 1920×1080). This file is the authority for the UI package so later work
does not need to re-fetch the mockups.

Source screens: `1a` main editor · `1b` effect stack + keyframe lanes · `1c` generator
run panel + job queue · `1d` in-place variant picking · `1e` segmentation ·
`1f` staging lane (alt) · `1g` stacked ghost variants (alt) · `1h` dense keyframe lane (alt).

Design decision from the mockup notes: keep `1f`'s **staging lane** in the main editor,
so pending generator output provably cannot disturb the cut while jobs run.

## Surfaces

| Token                | Value     | Use                                |
| -------------------- | --------- | ---------------------------------- |
| `--bg-app`           | `#0d0e11` | window ground                      |
| `--bg-panel`         | `#101216` | side panels, chrome, transport bar |
| `--bg-canvas`        | `#0b0c0f` | preview stage, timeline lane area  |
| `--bg-timeline`      | `#0f1115` | timeline container                 |
| `--surface-1`        | `#171a20` | inset fields, list rows, cards     |
| `--surface-2`        | `#1a1d23` | buttons at rest                    |
| `--surface-3`        | `#1e2229` | raised chips                       |
| `--surface-selected` | `#182233` | selected browser row               |
| `--track-active`     | `#141821` | focused track header               |

## Borders

| Token              | Value     | Use                              |
| ------------------ | --------- | -------------------------------- |
| `--border`         | `#23262d` | panel separators                 |
| `--border-subtle`  | `#1f232a` | inner rules, track separators    |
| `--border-control` | `#2b3038` | control outlines                 |
| `--border-dashed`  | `#2b3038` | "add from registry" drop targets |

## Text

| Token              | Value     | Use                          |
| ------------------ | --------- | ---------------------------- |
| `--text-primary`   | `#e2e6ec` | headings, active values      |
| `--text-bright`    | `#dfe3ea` | field values                 |
| `--text-secondary` | `#c3cad6` | labels                       |
| `--text-muted`     | `#9aa1ad` | inactive controls            |
| `--text-soft`      | `#8a919e` | parameter names              |
| `--text-dim`       | `#7d8492` | section captions (uppercase) |
| `--text-faint`     | `#5a6068` | metadata                     |
| `--text-ghost`     | `#4f555f` | drag handles, disabled       |

## Accents — each carries one meaning, consistently

| Token              | Value     | Meaning                                                |
| ------------------ | --------- | ------------------------------------------------------ |
| `--accent`         | `#4c9aff` | selection, playhead, snap, video-domain                |
| `--accent-strong`  | `#2b62b8` | primary button (Export)                                |
| `--generated`      | `#9b8cff` | **generator output** — anything the framework produced |
| `--generated-text` | `#cfc6ff` | label on generated clips                               |
| `--generated-dim`  | `#7a6fb8` | seed / provenance metadata                             |
| `--ok`             | `#38c1a4` | healthy, audio domain, cached ✓                        |
| `--ok-text`        | `#8fd8c7` | audio track labels                                     |
| `--warn`           | `#e0a44a` | text domain, pass-count warning                        |
| `--warn-text`      | `#e5be7c` | text track labels                                      |
| `--mask`           | `#ff7a52` | SAM 2 masks                                            |

Rule the mockups follow and the implementation must keep: **purple always means
"a generator made this"**. It appears on generated clips, the `generated/` folder, the
job-count chip and the variant placeholders — never on imported media.

## Domain colour pairs (clip bodies)

| Domain            | Fill                                                             | Border          |
| ----------------- | ---------------------------------------------------------------- | --------------- |
| video (imported)  | `linear-gradient(180deg,#2f3d5c,#26314a)`                        | `#40527a`       |
| video (selected)  | `linear-gradient(180deg,#33436a,#293656)`                        | `#4c9aff` (2px) |
| video (generated) | `linear-gradient(180deg,#2c2748,#241f3c)`                        | `#4b4180`       |
| audio (imported)  | `#17322e`                                                        | `#2f5f56`       |
| audio (generated) | `#2a2145`                                                        | `#4b4180`       |
| text              | `#38301d`                                                        | `#5c4c26`       |
| transition        | `repeating-linear-gradient(45deg,#3d4f7a 0 3px,#2a3556 3px 6px)` | `#56699a`       |

## Typography

- UI: `system-ui, -apple-system, "Segoe UI", sans-serif`
- Numeric / time / paths: `ui-monospace, Menlo, monospace` — **every** frame count,
  timecode, seed, hash and file size uses the mono stack so digits align in columns.
- Section caption: `600 10px`, `letter-spacing .09em`, uppercase, `--text-dim`
- Body label: `400 11.5px` · Field value: `500 11px` mono · Clip label: `500 10.5px`
- Large timecode readout: `600 19px` mono

## Metrics

| Element             | Size                                           |
| ------------------- | ---------------------------------------------- |
| title bar           | 44px                                           |
| panel header        | 34px                                           |
| media browser       | 300px wide                                     |
| inspector           | 340px wide                                     |
| transport bar       | 52px                                           |
| timeline panel      | 392px tall                                     |
| track header column | 148px                                          |
| timeline ruler      | 26px                                           |
| track heights       | V 64–84px · A 52–60px · T 46px                 |
| control height      | 26px · small 24px · badge 19px                 |
| radius              | 3px inset · 4px control · 5px card · 8px panel |

## Motion

The mockups are static, so motion is unspecified by them. Constraint from the spec's
16 ms timeline budget: no transition on anything that moves during a drag (clips,
playhead, keyframe markers). Transitions are allowed only on hover/focus tint and
panel open/close, capped at 120 ms.
