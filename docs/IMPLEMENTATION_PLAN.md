# Implementation Plan & Progress Ledger

> This file is the single source of truth for build progress. Every loop iteration
> reads it first, picks the next unchecked item, implements it, then checks the box
> **only after the code exists and its tests pass**. Never pre-check an item.
> Written in English per the project convention (the spec docs are Hungarian; code,
> comments and design docs are English).

## Architecture

Monorepo, npm workspaces. Every layer is interface-first: a package exports
`contracts/` (pure types + interfaces, zero runtime deps) and `impl/` (the current
implementation). Consumers depend on contracts only, wired through a DI container,
so implementations can be swapped without touching call sites.

```
packages/
  core/            domain model, rational time, document, patch/undo, DI, result types
  media/           asset identity, probing, proxy/filmstrip/waveform contracts
  compositor/      WebGL2 render graph, shader program cache, keyframe evaluation
  effects/         effect + transition manifest schema, registry, GLSL codegen
  generators/      generator manifest schema, registry, job queue, runner contract
  backend-comfyui/ ComfyUI runner (graph patching, WS progress, collection)
  ui/              design tokens + React component library (from the Claude Design mockups)
apps/
  desktop/         Electron main + preload + React renderer
  sidecar/         Python FastAPI: ffmpeg, probing, proxies, SAM 2, file watching
```

## Milestones

Spec milestones M1..M11 map to the phases below. Each phase lands with unit tests.

### Phase 0 — Repo foundation
- [x] npm workspaces, TypeScript strict base config, Vitest
- [ ] Shared lint/format config (eslint + prettier configs still to author)
- [x] `packages/core` scaffolding

### Phase 1 — M1: Document model, time math, project folder
- [x] Rational time + frame-index time math (`Rational`, `FrameRate`, `FrameIndex`,
      `FrameCount`, `FrameSpan`, SMPTE timecode incl. correct drop-frame)
- [x] Timeline document model (project, sequence, tracks, clips, transitions, effect
      instances, masks, markers) + branded ids + `AssetPath` validation
- [x] Parameter/keyframe model with per-marker easing and a binary-search evaluator
- [x] Immutable patch engine + undo/redo with gesture coalescing + `DocumentStore`
- [x] Project folder layout, `project.json` serialization + migration chain
      (validation combinators, hand-written serializer, versioned migration steps)
- [x] Autosave + crash recovery contract (never writes mid-gesture; recovery sibling
      file, staleness check against `project.json`)
- [x] Unit tests for the above (206 passing)

### Phase 2 — M2: Media
- [x] Asset identity (project-relative path) + content-hash cache keys
- [x] Media probe / proxy / filmstrip / waveform contracts
- [x] File watcher contract (ignore rules, event coalescing) + folder tree model
- [x] Sidecar foundation: path containment, ffmpeg/ffprobe command builders
      (verified against real ffmpeg: proxy, filmstrip tiling, float PCM extraction)
- [x] Sidecar HTTP endpoints: FastAPI app with token auth, `/health`,
      `/media/probe`, `/media/derive`, `/media/file`, `/project/scan`,
      `/cache/stats`, `/cache/clear`; content-hash cache, `.peaks` binary format,
      loopback-only entry point with a stdout port handshake (62 tests)
- [x] TypeScript sidecar client implementing the `@nos/media` contracts
      (`@nos/sidecar-client`: transport with typed errors, `.peaks` decoder,
      `MediaClient`; 36 unit tests + 14 integration tests against the live sidecar)
- [x] `@nos/ui`: design tokens (CSS variables + typed accessors), primitives,
      media browser with keyboard tree navigation and watcher status (27 tests,
      visually verified against mockup 1a via a Playwright screenshot)

### Phase 3 — M3/M4: Timeline editing + compositor
- [x] Editing operations (`@nos/editing`): split/razor, cut-all-tracks, head and
      tail trim, slip, move across tracks, lift, ripple delete (clip and range),
      snapping with candidate collection. 75 tests.
- [x] Timeline UI: viewport math (frames↔pixels, adaptive ruler ticks, anchored
      zoom), track headers with M/S/L, clip bodies with provenance/effect/mask
      badges and trim handles, ruler, playhead. 67 tests + screenshot-verified
      against mockup 1a.
- [x] Compositor plan builder + GLSL assembly (`@nos/compositor`): pure render plan
      shared by preview and export, gl-transitions wrapper, composite/passthrough
      programs, driver-log parsing. 70 tests + **all shaders compile and link in a
      real WebGL2 context**.
- [x] WebGL2 executor: ping-pong FBO pool, program cache with passthrough fallback,
      transform/opacity compositing, transitions, `TextureProvider` seam.
      **Verified in a real WebGL2 driver by pixel read-back: 16/16 assertions**
      (`cd packages/compositor && npm run glcheck:serve &` then `npm run glcheck`).
- [ ] Audio mix graph + scrub

### Phase 4 — M5/M6: Effects + keyframes
- [ ] Effect/transition manifest schema + registry + validation
- [ ] GLSL program cache, gl-transitions wrapper codegen, passthrough on error
- [ ] Keyframe evaluation (linear/ease-in/out/in-out/hold)
- [ ] Effect stack UI with drag & drop reorder
- [ ] Keyframe lane UI with per-marker easing badges

### Phase 5 — M7: Text layer
- [ ] Text clip model + rasterization cache
- [ ] Animation presets as keyframe generators
- [ ] Typewriter advance-list mechanism

### Phase 6 — M8: Export
- [ ] Offscreen render loop reusing the compositor
- [ ] ffmpeg pipe export (H.264/H.265), progress, cancel
- [ ] Export dialog UI

### Phase 7 — M9: Generator framework
- [ ] Manifest schema + validator (pointer resolution, requires, outputs)
- [ ] Registry with `available` / `unavailable` / `unbound` statuses + reasons
- [ ] Job queue: groups + runs, variants, seed constraints, batch fallback
- [ ] GPU semaphore
- [ ] Mock backend for framework tests
- [ ] Registry-driven parameter panel UI
- [ ] In-place variant picking on the timeline
- [ ] Manifest inspector

### Phase 8 — M10: ComfyUI backend
- [ ] Graph patching (bind pointers, `also` templates, preset pins)
- [ ] `/prompt`, `/ws`, `/history`, `/view`, `/upload/image`, `/object_info`
- [ ] Output collection + type-dispatched importers
- [ ] Manifests for the four supplied graphs

### Phase 9 — M11: SAM 2 masks
- [ ] Mask model, RLE/PNG-sequence cache
- [ ] Sidecar segmentation worker under the GPU semaphore
- [ ] Segmentation UI (click points, propagation range bar)

### Phase 10 — Hardening
- [ ] End-to-end smoke test (mock backend)
- [ ] Performance guard: timeline interaction budget
- [ ] Full typecheck + test suite green

## Current status

**Phases 1 and 2 complete (M1, M2). Phase 3 in progress — editing ops, timeline UI
and the whole compositor done; the audio mix graph remains.**
**572 TypeScript tests + 65 Python tests passing; `tsc --build` clean, `ruff` clean.**

Packages: `@nos/core`, `@nos/media` (contracts), `@nos/sidecar-client`
(HTTP implementation), `@nos/editing` (document transforms), `@nos/ui` (tokens +
components), `apps/sidecar` (Python).

Next: the audio mix graph and scrubbing, which closes Phase 3. The Electron shell
(`apps/desktop`) is still to be created; the `@nos/ui` visual harness
(`cd packages/ui && npx vite`, port 5199) stands in for it meanwhile and now renders
the media browser plus a full timeline from mockup 1a.

### Editing rules (keep these)

- Every operation is a pure `TimelineDocument -> Result<TimelineDocument,
  EditError>`. No mutation, no I/O, no UI knowledge, so a whole gesture composes
  inside one `store.transaction()` and collapses to one undo step.
- A rejected edit returns a **reason**. Same principle as the unavailable-generator
  rule: the UI must be able to say why a drag snapped back.
- Operations return the *same* document object for a no-op, which is how the store
  skips recording an empty history entry.
- Only the changed root-to-leaf path is rebuilt; untouched tracks stay by
  reference. That is what makes snapshot undo cost pointers instead of a copy, and
  a test asserts it.
- **Collisions are rejected, never resolved by displacing neighbours.** Silently
  moving material the user cannot see is the most destructive thing a timeline can
  do.
- Ripple is scoped to **one track**. Rippling everything would desynchronize layers
  aligned on purpose — the same reasoning the spec gives for discovered-length
  inserts never rearranging the video cut.
- Keyframes are clip-relative, so a **head trim and a split shift them**; a **slip
  does not**. An effect is authored against the clip's window, not against the
  material behind it.
- Head trim needs no `SourceBoundsResolver` (its limit is the clip's own
  `sourceIn`); tail trim and slip do, and proceed unchecked when bounds are unknown
  so editing is never blocked waiting on a probe.
- Snap thresholds are in **pixels**, converted via `framesPerPixel`. A frame-based
  threshold would snap wildly when zoomed out and not at all when zoomed in.

### Compositor rules (keep these)

- The **render plan is pure data**, built before any GL call. Preview and export
  build the same plan from the same document at the same frame, so WYSIWYG is
  structural rather than aspirational — there is no second code path to drift. A
  test asserts plan determinism.
- Everything decidable without GL is decided in the plan: live clips, enabled
  effects, evaluated uniforms, source frames. The GL layer stays mechanical.
- Track order in the document is **display** order (top row first). Compositing
  walks video tracks in reverse so the topmost row wins, and text composites above
  **all** video regardless of row — a title track at the bottom of the list is still
  a title.
- Speed and source-rate conversion compose **through seconds in one step**.
  Converting to the source rate and then scaling rounds twice and drifts on a
  retimed clip.
- A missing or broken effect is **dropped from the pass list**, never substituted
  with a no-op program: dropping keeps `passCount` honest, and that number drives
  the 8-pass warning. Over-budget plans still render — the spec asks for a warning,
  not a refusal.
- Transition `progress` is engine-computed from the overlap and is deliberately
  **not** in the uniform map, because the spec forbids exposing it as keyframable.
- A stale transition (referencing a clip that is not live, or an unknown effect)
  falls back to plain layers rather than blanking the picture.
- **GLSL must be verified by a real compiler, not by string assertions.** Generate
  the shaders, compile them in headless Chromium with
  `--use-gl=swiftshader --enable-unsafe-swiftshader`, and check both compile *and*
  link. Three bugs got through the unit tests and were caught only this way.
- The wrapper generates parameter uniform declarations from the manifest, so an
  author writes `u_amount` with no `uniform` line — **unless** the source declares
  its own (`declaresOwnUniforms`, implied by the gl-transitions convention), because
  a duplicate declaration is a compile error.
- The GL executor is the **only** file that touches GL, and it knows nothing about
  clips, keyframes, tracks or time. Preview and export differ solely in the
  destination framebuffer and the `TextureProvider`.
- Compositing goes into an **offscreen accumulator**, then blits. Drawing straight
  to the destination would make the result depend on whatever was already there —
  for export, an uninitialized buffer.
- Intermediate targets are **RGBA16F**. An eight-pass chain quantizes visibly in
  8-bit, showing as banding in gradients that each pass looks fine on, and the spec
  allows eight passes before it even warns.
- Alpha blending uses `blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE,
  ONE_MINUS_SRC_ALPHA)`. Using the colour factors for alpha too yields a wrong
  composite alpha wherever layers overlap — invisible in preview, wrong on an
  export with an alpha channel.
- A layer whose texture is not ready is **skipped**, not waited for: a preview that
  blocks on a decode turns a slow read into a frozen UI.
- Render targets come from a pool and must all be returned. The GL check asserts
  zero borrowed targets after a render and after 30 consecutive frames.
- `preambleLines` must be counted from the **joined** source, not `lines.length`:
  some entries are multi-line, and undercounting reports every diagnostic several
  lines off what the author wrote.

### Timeline UI rules (keep these)

- `frameToPx` deliberately does **not** round. Sub-pixel positions are what keep a
  clip's drawn edge on its frame; rounding accumulates into visible drift against
  the ruler.
- Hit testing uses `pxToFrameFloor`, not `pxToFrame`. A click anywhere in the pixel
  column for frame N must mean N — rounding resolves the column's right half to N+1,
  so clicking a clip's visible right edge would select the gap past it.
- Wheel zoom anchors on the pointer (`zoomAt`), or content slides out from under the
  cursor on every step.
- `scrollToReveal` **centres** rather than just revealing, and returns the same
  viewport when the frame is comfortably visible — otherwise following the playhead
  scrolls on every frame of playback.
- Off-screen clips are not rendered, so the DOM stays proportional to what is
  visible rather than to project length.
- Track headers adapt their layout to `track.height` (stacked above 52 px,
  side-by-side below). Heights are persisted and user-resizable, so a fixed layout
  clips its label — which is exactly what happened at the mockups' 46 px text track.

### UI rules (keep these)

- Every colour, size and font resolves through a token in
  `packages/ui/src/tokens/`. A literal hex in a component is a bug: the mockups
  assign one meaning per accent, and purple **always** means "a generator made
  this" — a literal breaks that mapping silently.
- Components are presentational. They hold only local interaction state (which
  rows are expanded, which field has focus); anything that outlives a render lives
  in the `DocumentStore` so undo and autosave see it.
- Numeric readouts (timecode, frame counts, seeds, hashes, sizes) use the mono
  stack so digits align and a changing value does not reflow its row.
- No transition on anything that moves during a drag — clips, playhead, keyframe
  markers. Transitions are hover/focus/panel-open only, capped at 120 ms, and are
  disabled under `prefers-reduced-motion`.
- Empty states explain themselves. "No clip selected" is information; a blank
  rectangle is not. Same reasoning as the spec's unavailable-generator rule.
- jsdom tests verify behaviour and accessibility but compute no layout. Anything
  layout-dependent needs the harness plus a screenshot.

### Commands
```
npm run test          # TypeScript suite
npm run typecheck     # tsc --build across workspaces
cd apps/sidecar && .venv/bin/python -m pytest    # sidecar suite
cd apps/sidecar && .venv/bin/ruff check src tests
```

- `@nos/core` — time layer, document model, parameter/keyframe model,
  patch/undo/autosave, `project.json` serialization + migration.
- `@nos/media` — asset classification, probe/derived/watcher contracts,
  content-hash cache keys, folder tree model with change application.
- `apps/sidecar` — `paths.py` (path containment) and `ffmpeg.py` (command
  builders), both verified against real ffmpeg.

Next: the FastAPI app exposing the sidecar routes, then the media browser UI.

### Sidecar rules (keep these)

- Every path from the renderer is untrusted. `resolve_in_project` checks
  containment *after* resolution so a symlink pointing outside the project is
  caught too — textual validation alone would miss it. This duplicates the
  TypeScript check on purpose: the sidecar is a localhost HTTP server and must not
  assume its only caller is well behaved.
- ffmpeg is invoked with argument *lists*, never a shell, so a filename containing
  a quote or semicolon cannot become command injection.
- All ffmpeg argument construction lives in `ffmpeg.py` and is a pure function of
  its inputs, so it is testable without spawning a process.
- Proxy `short_edge` is the `p` number (1080p = 1080 lines landscape, 1080 columns
  portrait). It is **not** a cap on the long edge.
- The sidecar binds loopback-only (a non-loopback `--host` is refused) and requires
  a shared token on every endpoint except `/health`. Without it, any local process
  — including a web page fetching `127.0.0.1` — could read arbitrary files through
  `/media/file`. The token arrives via `NOS_SIDECAR_TOKEN`, never argv, because
  command lines are visible in the process table.
- `__main__` binds the socket itself and prints
  `{"event":"listening","port":N}` on stdout before serving, so the parent learns
  the port without scraping logs or racing the bind.
- Derived artifacts are written to a hidden temp sibling and renamed. The temp name
  **must keep the real suffix** — ffmpeg infers its output container from the
  extension, so `foo.mp4.partial` fails with exit 234.
- FastAPI dependency providers must be **module-level**, not closures inside
  `create_app`. With PEP 563 annotations FastAPI resolves `Depends(...)` against
  module globals; a closure-local reference silently degrades the parameter to a
  query field and every request 422s.
- `/media/file` is the **only** endpoint accepting the token as a query parameter.
  `<video src>` and `<img src>` cannot send headers, so proxies and filmstrips need
  it in the URL; everywhere else the header is required, because a token in a URL
  leaks more easily. A test asserts other endpoints still reject a query token.
- The `.peaks` header is **28 bytes** (`<8sIIIII`), not 32. The cross-language
  fixture test in `@nos/sidecar-client` pins it — getting it wrong shifts the whole
  float payload. Regenerate the fixture if the format changes; the generator command
  is in the log entry below.
- Float32 values never equal their decimal literals (`-0.9` reads back as
  `-0.8999999761581421`). Compare peak values with `toBeCloseTo`, never `toEqual`.

### File format rules (keep these)

- The on-disk shape and the in-memory shape are allowed to differ, and
  `packages/core/src/serialization/` is the *only* place that knows both.
- The file optimizes for being read, diffed and hand-edited: frame rates as
  `"30000/1001"`, a constant parameter as a bare number, fields equal to their
  default omitted, two-space indent, trailing newline, never `null`.
- Every serializer omission must have a matching schema default. The
  "preserves a document using every field" round-trip test is what enforces this —
  extend that fixture whenever a field is added.
- Unknown keys are ignored on load (forward compatibility), but a file from a
  *newer* `schemaVersion` is refused outright rather than best-effort parsed,
  because dropping fields and then saving would destroy work invisibly.
- `vWithDefault` substitutes for *absent* values only. `vFallback` also swallows
  invalid ones and is restricted to closed vocabularies where degrading beats
  refusing (currently only keyframe easing).
- Migrations run on raw JSON *before* validation, one step per version, and a
  released step is never edited.

### Resolved spec conflicts (do not re-litigate)

- **Keyframe time base.** `interfaces.md` §4.5 shows keyframe `t` in *seconds*;
  spec §7 mandates frame indices for every time value. **Frame indices win** —
  seconds reintroduce the drift the time layer exists to remove, and a keyframe off
  the frame grid cannot evaluate identically in preview and export. Seconds appear
  only in the UI and in shader uniforms.
- **Per-marker easing direction.** A keyframe's easing governs the segment
  *leaving* it. Only that assignment makes `hold` mean "keep this value until the
  next marker". The final keyframe's easing is deliberately unused.
- **Undo via snapshots, not inverse patches.** The spec asks for "patch
  coalescing"; snapshot-plus-gesture-coalescing is user-visibly identical and far
  cheaper to keep correct. Every edit already produces a new immutable document with
  structural sharing, so a snapshot costs pointers, not a copy. Coalescing is driven
  by an explicit gesture scope rather than a time window, because time-based merging
  depends on mouse speed and cannot be tested.

### Conventions established (keep these)
- Interface-first: types and interfaces separate from implementations; consumers
  import contracts, never concrete classes.
- `Result<T, E>` for expected failures (validation, pointer resolution, shader
  compilation). Exceptions only for programmer error.
- Branded types for every id and for `FrameIndex` vs `FrameCount`. Mint brands only
  in validating factories via `unsafeBrand`.
- Half-open `[start, end)` frame spans — the only convention that makes clip
  adjacency unambiguous.
- Comments explain *why*, not *what*. Tests name the behaviour and its rationale.

## Log

- 2026-08-08: Ledger created. Spec + interface contracts read, Claude Design
  mockups pulled (8 screens, 1920×1080) and design tokens extracted to
  `docs/design-tokens.md`.
- 2026-08-08: Workspace scaffolding (npm workspaces, strict TS, Vitest) +
  `@nos/core` time layer: exact rational arithmetic, `FrameRate`, `FrameIndex`/
  `FrameCount`, `FrameSpan` interval algebra, SMPTE timecode with real drop-frame
  support. 72 tests. Two bugs caught by the suite while writing it: `isDropFrameRate`
  compared 29.97 against 30 (29.97 is *below* 30, so the canonical drop-frame rate
  was classified non-drop), and `ceil` leaked `-0` for negative halves.
- 2026-08-08: Document model (`ids`, `params`, `clip`, `track`, `document`) and the
  mutation layer (`history`, `store`, `autosave`). 149 tests. `DocumentStore` is the
  single mutation point for the whole app — undo, dirty tracking and autosave are
  therefore uniform rather than per-feature. `transaction()` closes its gesture in a
  `finally`, so a drag handler that throws cannot leave the history swallowing every
  later edit into one entry (covered by a test).
- 2026-08-08: **Phase 1 closed.** Validation combinators (`lang/validate.ts`,
  reused later by both manifest validators — they accumulate every issue with its
  JSON path, which is what the spec's "name the broken pointer" rule needs),
  `project.json` serializer, and the migration chain. 206 tests. The round-trip
  test caught that a documented behaviour did not exist: the schema comment claimed
  an unknown easing degrades to linear, but `vWithDefault` only covers *absent*
  values, so a `"bezier"` easing failed the whole load. Added `vFallback` for that
  narrow case rather than loosening `vWithDefault`, which would have turned typos
  into silent data loss on the next save.
- 2026-08-08: `@nos/media` contracts + folder tree, and the sidecar foundation
  (`paths.py`, `ffmpeg.py`). 281 tests. Ran the ffmpeg command builders against
  real ffmpeg on synthesized landscape and portrait sources rather than trusting
  that they read correctly — which caught a naming bug: `ProxySpec.maxEdge` was
  documented as "long-edge pixels", but portrait 1080×1920 came out 720×**1280**,
  exceeding the supposed cap. The filter was right for `1080p` semantics (what the
  spec asks for); the *name* was the lie, and it would only ever have shown up on
  vertical footage. Renamed to `shortEdge` across both languages.
- 2026-08-08: Sidecar HTTP layer complete — FastAPI app, content-hash cache
  (memoized by `(size, mtime_ns)` and persisted, so reopening a project rehashes
  nothing), `.peaks` binary format, loopback entry point. 62 Python tests, all
  against real ffmpeg and real files; nothing mocked, because the sidecar's whole
  job is driving ffmpeg correctly and refusing paths it shouldn't read — neither
  property survives stubbing. Three bugs the tests caught: the FastAPI closure
  dependency issue (every request 422'd), the `.partial` extension breaking
  ffmpeg's container inference (exit 234), and one wrong *test* expectation — I
  assumed lavfi's `sine` filter is full-scale, but it defaults to amplitude 0.125,
  so the peak reduction was correct all along. Rewrote the fixture to generate a
  stated amplitude via `aevalsrc`, which upgraded the assertion from "is it large"
  to "does the reduction preserve level".
- 2026-08-08: `@nos/sidecar-client` — typed HTTP transport, `.peaks` decoder,
  `MediaClient` translating wire payloads into domain types at the boundary (rate
  strings → `FrameRate`, seconds → milliseconds, snake_case → camelCase), so no
  loose string reaches the compositor. 36 unit tests with an injected fetch plus
  **14 integration tests that spawn the real sidecar** and assert the wire contract
  end to end; they skip cleanly when the venv or ffmpeg is absent.

  Two bugs found here, both by the cross-language fixture test:
  1. The `.peaks` header size was 32 in TypeScript but 28 in Python — the fixture's
     348 bytes only reconcile at 28. Would have shifted every float and produced
     plausible-looking garbage waveforms.
  2. `fileUrl` put the token in a query parameter, which the sidecar did not accept
     at all — every proxy and filmstrip would have 401'd in the UI. Fixed by scoping
     a query-token concession to `/media/file` only.

  Fixture regeneration (run from `apps/sidecar`, writes into `@nos/sidecar-client`):
  a deterministic stereo ramp — channel 0 rising, channel 1 the negated half — so a
  channel-order or stride mistake cannot pass. See git history for the exact script.
- 2026-08-08: **Phase 2 closed.** `@nos/ui` — design tokens transcribed from the
  mockups, primitives at the mockups' exact metrics (34 px header, 26 px control,
  19 px badge), and the media browser: keyboard-navigable tree with `aria-level`/
  `aria-expanded`/`aria-selected`, per-type swatches, watcher status with a manual
  rescan on failure, and a detail pane reporting derived-artifact readiness.
  27 component tests, all green first run.

  Then verified it *visually* in a real browser via a Playwright screenshot, which
  caught a deviation jsdom could not: `project.json` had sunk to the bottom of the
  tree, because the general rule puts directories before files. The mockups place it
  first — it is the file that *is* the project. Fixed with a root-scoped pin; the
  first attempt pinned the name at any depth, so a `notes/project.json` would have
  jumped its folder's queue too, and a test now covers both cases.

  Harness: `cd packages/ui && npx vite` (port 5199). Note the MCP Playwright server
  wants Chrome at `/opt/google/chrome/chrome`, which is absent here; the bundled
  Chromium via the `playwright` package works.
- 2026-08-08: `@nos/editing` — the full editing operation set, 75 tests, 53 of them
  green on the first run. The interesting decisions are recorded as rules above; the
  subtle one is keyframe handling, where a split and a head trim must rebase
  clip-relative keyframes but a slip must not, and getting that backwards produces
  effects that visibly drift against the picture.

  One failure was again a wrong *test*: I asserted `start + duration === 150` after
  an end-edge snap to a candidate at 100, which is arithmetically impossible — the
  snapped edge lands *on* the candidate. The implementation was right and an earlier
  test already covered it correctly.
- 2026-08-08: Timeline UI — viewport math (43 tests) plus components (24 tests),
  then screenshot-verified against mockup 1a. Two findings the screenshot produced
  that jsdom could not:

  1. The **T1 track header overflowed its 46 px row** and clipped its label: stacked
     content needs label + gap + toggles + padding = 50 px. Fixed by adapting the
     header layout to the row height, which also survives the user resizing a track.
  2. Writing the tick generator I found my own `drawMinor` guard was **unreachable** —
     major ticks are ≥72 px apart by construction, so a quarter subdivision is always
     ≥18 px. Replaced the dead branch with adaptive subdivisions (10/5/4/2/1, largest
     that stays ≥9 px and divides the interval evenly), so the ruler genuinely gains
     detail as you zoom instead of switching between two fixed densities.

- 2026-08-08: `@nos/compositor` — the pure half: render-plan builder (37 tests) and
  GLSL assembly (33 tests). Then compiled the generated shaders in a real WebGL2
  context, which found **three bugs no string assertion could**:

  1. **Every effect with parameters failed to compile.** The wrapper generated
     sampler declarations but not parameter ones, so `u_amount` was an undeclared
     identifier. Fixed by giving the contract typed uniform declarations
     (`{name, type}`) and generating them — which also means the manifest is the
     single declaration site.
  2. **`float ratio = u_resolution.x / u_resolution.y;` at global scope is illegal**
     — GLSL ES requires constant global initializers. Every gl-transitions shader
     would have failed. Now declared bare and assigned in the generated `main`.
  3. Earlier, a unit test caught `preambleLines` undercounting by 3 because the
     four-line built-in uniform block is one array element — every shader diagnostic
     would have pointed 3 lines off.

  Verified afterwards: all 7 programs compile *and* link, including a
  gl-transitions shader that reads `ratio`, one with its own `uniform` line, a
  masked blur with a `bool`, and one using all four spec-mandated built-ins. The
  passthrough program also actually draws — a 1×1 source texture reads back exactly
  at the centre pixel, proving the attribute-free fullscreen triangle works.

- 2026-08-08: WebGL2 executor complete. Verified by **pixel read-back in a real
  driver** — 16 assertions covering: a bare layer reproducing its source; a pass
  actually running with its uniform set; two passes chaining through the ping-pong
  (red halved twice reads 64, where a target reading its own output would read 128);
  the mask sampler bound to its own unit; all four built-in uniforms set from the
  layer; a broken shader degrading to passthrough with the picture intact *and* its
  diagnostic correctly rebased to authored line 1; source-over opacity blending;
  layer order; a gl-transitions wipe at both ends of its progress; a missing texture
  skipping only its own layer; and zero pool leaks after 30 frames.

  One assertion failed first time and it was my *test*, not the compositor: the mask
  shader multiplied alpha as well as RGB, so the read-back depended on two effects at
  once. Also strengthened the mask fixture from white to mid-grey — against a red
  source, a white mask cannot distinguish "bound correctly" from "bound to the
  source texture", since red's own R channel is 1.0 either way.

  Also resolved the recurring `exactOptionalPropertyTypes` friction properly:
  component callback props are now declared `(() => void) | undefined` rather than
  `?: () => void`, because a parent forwarding its own optional handler is the normal
  case and conditional spreads at every call site were pure noise.
