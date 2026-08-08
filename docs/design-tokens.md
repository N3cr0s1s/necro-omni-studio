# Design tokens

**This file no longer defines any colour, and neither does the repository.**

The palette is a shadcn preset, applied verbatim into `packages/ui/src/styles/globals.css` and never
edited. Everything below describes how to *read* it. The authority is that file and
`packages/ui/README.md`; this page exists so the older references to `--nos-*` variables have
somewhere to point.

## What replaced the token table

Until the shadcn refactor (issue #21) this document was a hand-extracted table of hex values taken
from the Claude Design mockups — `--bg-app: #0d0e11`, `--surface-2: #1a1d23`, thirty more like them —
mirrored into `packages/ui/src/tokens/tokens.css` and reached through a typed `token` accessor. That
file, its accessor and the `Primitives.tsx` built on them are deleted.

The preset in use:

```
shadcn preset decode b4zkmXhPE
  style nova · baseColor taupe · theme rose · radius none · icons lucide · font inter
```

`style: base-nova` is the registry's current default, which is built on [Base UI](https://base-ui.com)
— not Radix. Changing the palette means applying a different preset, not editing a variable.

## Reading a colour

Never as a value. A component names a **role**, as a Tailwind class, written out in full so Tailwind's
source scan can see it — an interpolated `text-${tone}` is a class it never compiles.

| Role                                | Means                                                             |
| ----------------------------------- | ----------------------------------------------------------------- |
| `primary`                           | the playhead, the transport, the thing a click confirms           |
| `secondary`                         | a control that is on without being the point                      |
| `destructive`                       | a refusal, a failure, a removal                                   |
| `muted` / `muted-foreground`        | surfaces behind content, and secondary text                       |
| `accent`                            | the hover and focus wash the registry applies for itself          |
| `border` / `input` / `ring`         | edges, fields, focus                                              |
| `chart-1` … `chart-5`               | **categories**: an asset type, a track kind, a clip's provenance  |

Two rules that are not obvious from the list:

1. **`chart-4` means "a generator made this"**, everywhere — the browser glyph, the clip body, the
   variant picker's edge, the seed readout. It is the one categorical role with a fixed meaning.
2. **There is no warning role, and one has not been invented.** Where a state sits between fine and
   broken — a meter above −6 dBFS — it is a softened `destructive`. A hand-picked amber would stop
   being legible the moment the preset changed; an opacity on a role does not.

Dark and light need no thought at all: the same class names resolve differently under `.dark`, which
`next-themes` puts on the root element. Nothing in the application reads the current mode.

## Reading a metric

The layout numbers the mockups fixed are now Tailwind's own scale, in the class rather than in a
variable — `h-98` for the timeline's 392 px, `w-37` for the 148 px track-header column, `h-6.5` for the
26 px ruler. They are unchanged; they are simply no longer indirected through a name that only one
file used.

`style` is still the right answer for a number that is *computed*: the timeline resolves a clip's
`left` and `width` per frame from zoom and scroll, and there is no class for a value that changes on
every pointer move. Everything that is not a computed position is a class.

## The two literal colours in the repository

Neither is styling, and both are documented where they live:

- `apps/desktop/src/main/main.ts` — the `BrowserWindow` background, painted before a stylesheet
  exists. It mirrors the preset's dark background and is the one value that has to follow a palette
  change.
- `apps/desktop/src/renderer/clip-strips.ts` — the waveform body. That is pixels, rasterised into a
  PNG and cached beside the audio; it can no more follow a runtime theme than a video frame can.

## What the mockups are still the authority for

Layout and behaviour, not colour. The source screens remain worth reading for what goes where:

`1a` main editor · `1b` effect stack + keyframe lanes · `1c` generator run panel + job queue ·
`1d` in-place variant picking · `1e` segmentation · `1f` staging lane · `1g` stacked ghost variants ·
`1h` dense keyframe lane.

The decision from the mockup notes still holds: keep `1f`'s **staging lane** in the main editor, so
pending generator output provably cannot disturb the cut while jobs run.
