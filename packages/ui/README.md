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

## Deviations from the registry as shipped

Kept to a minimum, and listed here because they are invisible otherwise. If a `shadcn add` overwrites
one, `npm run typecheck` fails and it needs re-applying:

- `ui/sonner.tsx` — `theme={theme as NonNullable<ToasterProps['theme']>}`. The repository compiles
  with `exactOptionalPropertyTypes`, under which passing an explicit `undefined` to an optional prop
  is an error; the value is already defaulted to `"system"` one line above, so the assertion only
  tells the compiler what the code already guarantees.

## Adding a component

```bash
cd packages/ui && npx shadcn@latest add <name>
```

It will land in `src/components/ui/`, already importing `@nos/ui/lib/utils`. Nothing else needs
wiring: Tailwind finds the class names through the `@source` lines in `src/styles/globals.css`.
