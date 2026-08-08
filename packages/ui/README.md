# `@nos/ui`

The application's components. Two layers, and the boundary between them matters:

- **`src/components/ui/`** — the shadcn registry, vendored by `shadcn add`. Not written here and not
  formatted or linted here (see `.prettierignore` and `eslint.config.js`), so that `shadcn diff` and
  the next `shadcn add` show a real change rather than a whitespace one.
- **everything else** — the panels this application is made of, composed from that registry.

## Configuration

`components.json` pins the setup, and it came from the preset the design was chosen in:

```
shadcn preset decode b4zkmXhPE
  style nova · baseColor taupe · theme rose · radius none · icons lucide · font inter
```

`style: base-nova` is the current default registry, which is built on
[Base UI](https://base-ui.com) — **not** Radix. Base UI's conventions differ in ways that matter when
composing: `render={<X />}` replaces Radix's `asChild`, and popups are assembled as
`Portal → Positioner → Popup` rather than a single content element.

Aliases resolve through this package's own `exports` map, so a component is imported the same way
from inside the library and from the desktop app:

```ts
import { Button } from '@nos/ui/components/ui/button';
import { cn } from '@nos/ui/lib/utils';
```

## Rules this package holds itself to

1. **No colour is defined here.** The palette is the preset's, in `src/styles/globals.css`, and
   components reference it only by role — `primary`, `secondary`, `destructive`, `muted`, `accent`,
   `border`, `ring`. There is no second palette to keep in sync, and nothing to change for dark mode:
   the same class names resolve to different values under `.dark`.
2. **No Tailwind override of a shadcn component's own styling.** A `className` on a shadcn component
   is for layout — where it sits, how much room it takes — not for repainting it.
3. **Light and dark are `next-themes`' job.** Nothing in this package reads the current mode.
4. **`style` is for arithmetic, never for appearance.** The timeline computes a clip's `left` and
   `width` per frame from zoom and scroll; there is no class for a number that changes on every
   pointer move. Everything that is _not_ a computed position is a class.

### Where a role goes

- `primary` — the playhead, the transport, the thing a click confirms.
- `destructive` — a refusal, a failure, a removal. Never a warning that is merely worth reading.
- `muted` / `muted-foreground` — surfaces behind content, and secondary text.
- `chart-1…5` — **categories**, not states: an asset type, a track kind, a clip's provenance. Asset
  types are categories, so they must not borrow `primary` or `destructive`, whose meanings are taken.
- `chart-4` in particular means **a generator made this**, everywhere: the browser glyph, the clip
  body, the variant picker's edge, the seed readout.

There is no "warning" role in the theme, and one has not been invented. Where a state sits between
fine and broken — a meter above −6 dBFS — it is a softened `destructive`, which stays correct under
any palette in a way a hand-picked amber would not.

## Two literal colours, and why they are not styling

- `apps/desktop/src/main/main.ts` — the `BrowserWindow` background. The main process runs unbundled
  and cannot read a stylesheet; this only colours the frame between the window opening and the
  renderer painting. It mirrors the preset's dark background, and is the one value outside
  `globals.css` that has to follow a palette change.
- `apps/desktop/src/renderer/clip-strips.ts` — the waveform body. That is _pixels_: rasterised into a
  PNG and cached beside the audio, so it cannot follow a theme that changes at runtime any more than
  a video frame can.

## Deviations from the registry as shipped

None. Every file in `src/components/ui/` is byte-for-byte what `shadcn add` wrote, which is what makes
`shadcn diff` meaningful and an upgrade a real diff rather than a merge.

`sonner` is deliberately **not** installed: it was the one component that needed a patch to compile
under `exactOptionalPropertyTypes`, and nothing in this application raises a toast. `shadcn add sonner`
brings it back in one command on the day something does.

## Adding a component

```bash
cd packages/ui && npx shadcn@latest add <name>
```

It will land in `src/components/ui/`, already importing `@nos/ui/lib/utils`. Nothing else needs
wiring: Tailwind finds the class names through the `@source` lines in `src/styles/globals.css`.
