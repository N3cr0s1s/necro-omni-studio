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
- [x] Shared lint/format config. Prettier owns formatting at the width the code
      was already written to, so adopting it moved no logic; eslint keeps only the
      rules a strict type checker cannot express — unused code, stray `any`,
      `prefer-const` — because a rule everyone disables is worse than no rule.
      `npm run verify` runs format, lint, typecheck and tests in one pass.
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
- [x] Audio mix graph + scrub (`@nos/audio`): pure mix plan shared by playback and
      export, gain automation sampling, equal-power pan, Web Audio lookahead
      scheduler, grain-based scrubbing, peak metering with decay. 47 tests.

### Phase 4 — M5/M6: Effects + keyframes

- [x] Effect/transition manifest schema + registry + validation (`@nos/effects`),
      implementing the compositor's `EffectSourceResolver`; built-in library of 4
      effects + 2 transitions, every one compiled by the GL check. 36 tests.
- [x] GLSL program cache, gl-transitions wrapper codegen, passthrough on error
      (landed with the compositor in Phase 3)
- [x] Keyframe evaluation (linear/ease-in/out/in-out/hold) — landed in `@nos/core`
      Phase 1, consumed by the plan builder
- [x] Effect stack UI with pointer **and keyboard** reorder, health dots, shader
      error surfacing, pass-budget warning. 28 tests.
- [x] Keyframe lane UI: diamond markers, per-marker easing badges, drag/nudge,
      easing cycling, value readout under the playhead. 26 tests.
      Screenshot-verified against mockup 1b.

### Phase 5 — M7: Text layer

- [x] Text rasterization cache contracts + cache key over exactly the
      non-animatable properties (`@nos/text`). 25 tests.
- [x] Animation presets as pure keyframe generators, with merge/remove that
      preserve hand-authored animation. 35 tests.
- [x] Typewriter advance-list mechanism + word wrapping with character fallback.
      26 tests.
- [x] Canvas 2D rasterizer + mark-and-sweep raster cache. Verified against a real
      font engine: 19/19 assertions
      (`cd packages/text && npx vite --port 5201 &` then
      `node packages/text/rastercheck/run.mjs`).

### Phase 6 — M8: Export

- [x] Export settings, validation, size estimate, frame iteration, progress
      tracking (`@nos/export`). Calls `buildRenderPlan` directly — no
      export-specific plan builder. 34 tests, including one asserting the export
      plan is **identical** to the preview plan for the same frame.
- [x] ffmpeg pipe encoder in the sidecar: streaming stdin, H.264/H.265, audio
      muxing, progress, cancel. 17 tests against real ffmpeg, verifying a playable
      mp4, the frame count, the exact frame rate and **decoded pixel orientation**.
- [x] Export dialog UI: continuous validation, codec/quality/speed choices, size
      estimate, progress, cancel. 28 tests.

### Phase 7 — M9: Generator framework

- [x] Manifest contracts: consumes/produces descriptors, presets as separate UI
      entries, `also` bindings, batch descriptor, duration mode, unbound detection
- [x] Manifest validator + registry with `available`/`unavailable`/`unbound`
      statuses and concrete reasons. Graph pointer resolution, `also` targets,
      output nodes, required node classes. **Validated against the real ComfyUI
      graphs in `docs/comfy/`.** 25 tests.
- [x] Variant planning: seed constraints, sequential default, batch splitting.
      19 tests.
- [x] Job queue: groups + runs, progress, cancellation, partial results, GPU
      serialization. 31 tests.
- [x] Mock backend — a shipped artifact, not a fixture: makes the framework
      demonstrable and testable with no GPU and no ComfyUI, which is why the spec
      separates M9 from M10.
- [x] GPU semaphore: serialized, idempotent release, cancellable waits, status
      reporting. 16 tests.

- [x] Registry-driven parameter panel UI: controls chosen by declared _type_
      only, live enum options, presets hiding their pins, variant control tied to
      whether a seed exists. Nothing branches on a generator id. 33 tests.
- [x] In-place variant picking: a pure staging model (candidates from a group's
      runs, stepping across ready ones so partial results are usable at once,
      accept/discard as outcomes rather than mutations) plus the picker and
      placeholder from mockup 1d. Placeholder length comes from the manifest's
      declared length parameter, provisional lengths flagged. 33 + 24 tests.
- [x] Manifest inspector: a pure `ManifestDraft` with type/key inference,
      validation split into blocking errors and non-blocking warnings so an
      unbound contract can still be saved, and a two-column UI that lists a
      graph's literal inputs and previews the file it writes. 37 + 26 tests.

### Phase 8 — M10: ComfyUI backend

- [x] Graph patching (bind pointers, `also` templates, preset pins, batch size),
      **verified against the real graphs in `docs/comfy/`**. 21 tests.
- [x] `/prompt`, `/ws`, `/history`, `/upload/image`, `/object_info`, cancel.
      22 tests with a scripted transport.
- [x] Output collection keyed by node, so the manifest decides what an output means
- [x] Manifest file format: parser and serializer for the spec's on-disk
      snake_case, in one module so the naming leaks into neither side.
- [x] Manifests for **all five** supplied graphs, in `generators/`. A library test
      validates each against its own real graph — pointers, output nodes and
      `requires` — and checks coherence properties (defaults inside ranges, pins
      naming real parameters, no two parameters on one pointer). 17 tests.

### Phase 9 — M11: SAM 2 masks

- [x] `@nos/masks`: mask model, prompts, session reducer. Engine-agnostic — the
      segmenter is an interface, and nothing in the package knows what SAM 2 is.
      73 tests.
- [x] RLE codec in **COCO's column-major layout**, so masks from any SAM-family
      tool decode unchanged. Implemented twice — TypeScript and Python — and the
      two are pinned to one shared fixture in both test suites.
- [x] Mask cache under `masks/`, keyed by source + range + prompt **order**. A
      corrupt frame is a miss rather than a failure.
- [x] Sidecar segmentation worker: engine protocol, probed availability reported
      with a concrete reason, local GPU serialization, partial results kept
      through a failure or cancel, malformed masks rejected before the cache.
      54 tests.
- [x] Segmentation UI: normalized click overlay, alt-click to exclude, prompt
      list that seeks, propagation range bar that fills as masks land. 31 tests.
- [x] Mask textures bound to the compositor's `mask` sampler slot, allocating
      once per mask and re-uploading in place per frame. **Verified end to end
      against a real WebGL2 driver**, including a transposition check.

### Phase 10 — Hardening

- [x] End-to-end smoke test in `@nos/smoke`: the shipped library is discovered,
      a generator runs on the mock backend, a variant is picked, its output lands
      as a clip with provenance, the compositor plans it, the mixer hears it, the
      export planner sizes it, and the project round-trips. Crosses **package
      boundaries** — which is where the bugs each package's own tests cannot see
      live. It found one: batched runs collapsed three variants into one.
- [x] Performance guard: render and mix planning, a clip move, a split and an
      undo, all inside the spec's 16 ms interaction budget on a 2000-clip
      project — each timing check paired with the structural assertion that
      explains why it holds, so a regression points at the cause.
- [x] Full typecheck + test suite green

## Current status

**Phases 1–10 complete (M1–M11 plus hardening). The generator framework works end to end: five
manifests in `generators/` cover every supplied graph, the registry validates
them against the real files, and the panel, variant picker and manifest inspector
are all driven by the manifest alone. The mask pipeline reaches the compositor's
`mask` sampler with the whole path verified on a real driver.**
**1339 TypeScript tests + 136 Python tests passing; `tsc --build` clean, `ruff` clean,
22/22 compositor GL assertions, 19/19 text rasterizer assertions.**

Committed on branch `build/foundation` (local only, not pushed).

Packages: `@nos/core`, `@nos/media` (contracts), `@nos/sidecar-client`
(HTTP implementation), `@nos/editing` (document transforms), `@nos/compositor`,
`@nos/effects`, `@nos/audio`, `@nos/text`, `@nos/export`, `@nos/generators`,
`@nos/backend-comfyui`, `@nos/masks`, `@nos/ui` (tokens + components),
`apps/sidecar` (Python). Generator library in `generators/`.

The **Electron shell** (`apps/desktop`) now exists and runs: `cd apps/desktop &&
npm start` builds the main process, the preload and the renderer, then opens the
editor. Verified by launching it and inspecting the live window — the editor
paints, `window.require` is undefined, the bridge exposes exactly its eight
methods, and no page errors are raised. The `@nos/ui` visual harness
(`cd packages/ui && npx vite`, port 5199) remains for component work.

The shell mounts the media browser, the timeline, and a tabbed right column with
the clip inspector, the generator panel, the variant picker and segmentation. It
loads the project's `generators/` folder into a real registry and talks to the
live ComfyUI instance through the main process.

**Verified against the running application and the real ComfyUI**: the sidecar
spawns and answers, the last project reopens on launch, the library loads, the
backend reports **1102 installed node classes**, and all five manifests validate
as `ready` with their parameters, presets and capability badges rendered entirely
from JSON. No page errors.

The **preview** is mounted: the same compositor the export uses, fed by textures
decoded from the sidecar's file endpoint. Verified end to end against a real clip
— the frame composites at the playhead and the canvas measures 16:9.

**Dragging, trimming and the transport** are in: a clip follows the pointer live
and commits as one undo step, a rejected move stops with its reason, and space /
arrow keys drive playback at the project rate (verified: one second advances
exactly 30 frames at 30 fps).

Next: driving the audio engine from the transport (the engine and mix planner are
built and tested but not yet connected to playback), and landing a chosen variant
onto the timeline as a clip.

### Editing rules (keep these)

- Every operation is a pure `TimelineDocument -> Result<TimelineDocument,
EditError>`. No mutation, no I/O, no UI knowledge, so a whole gesture composes
  inside one `store.transaction()` and collapses to one undo step.
- A rejected edit returns a **reason**. Same principle as the unavailable-generator
  rule: the UI must be able to say why a drag snapped back.
- Operations return the _same_ document object for a no-op, which is how the store
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
  `--use-gl=swiftshader --enable-unsafe-swiftshader`, and check both compile _and_
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

### Generator framework rules (keep these)

- A manifest declares what it **consumes and produces**, never what it "is". The UI
  derives placement from that pair, so TTS and video generation need no special
  cases — they differ only in their descriptors.
- A `consumes` **role** is what makes a capability placeable. The same node class
  serves t2v and i2v, so the difference cannot be inferred from the graph and must
  be declared.
- Variants come from varying the **seed**. No seed parameter, or a locked seed,
  forces one variant **and carries the reason** — the spec requires the UI to say
  why rather than silently return identical results. A constraint is reported only
  when it actually reduced something; explaining a limit the user did not hit trains
  people to ignore explanations.
- Execution is **sequential by default**. Batched is faster but scales VRAM and needs
  graph support, so it is opt-in. Above `batch.max` the runner **splits** into
  several batched runs rather than failing or abandoning batching.
- The GPU semaphore is **serialized, not pooled**: the failure mode is an
  out-of-memory abort partway through a job the user already waited minutes for. An
  occasionally idle queue is a far better trade.
- Release is **idempotent** — a `finally` plus an explicit release must not hand the
  next turn out twice and run two GPU jobs at once. `withGpu` releases in a
  `finally`, because a leaked lease deadlocks every generator, mask and export for
  the rest of the session.
- A cancelled wait is **removed from the queue**, so a cancelled job does not block
  everything behind it for the duration of a run that will never happen.
- The semaphore holder is **exposed**, because the mockups show jobs waiting on
  segmentation. A progress bar that stops with no explanation reads as a hang.
- A generator that cannot run is **kept with a reason**, never dropped — including
  from `entriesForSurface`, since filtering there _is_ the disappearing-tool
  behaviour the spec forbids. Every problem is reported, not just the first.
- `unbound` is distinct from `unavailable`. Nothing is broken; the graph simply has
  not been connected. Different user response — a to-do, not a bug — so an unbound
  manifest is not pointer-checked at all, or the one fact that matters would be
  buried under a list of null binds.
- A pointer failure names **how far it got** (`/52:3/inputs has no "x"`), which is
  the difference between a two-second fix and a hunt through the graph.
- `requires` is **not checked** until the backend has reported its node classes.
  Greying out every generator while the backend starts is worse than briefly
  optimistic.
- `patchPointer` is **immutable**. The same parsed graph is reused for every run, so
  a mutating patch would make the second run inherit the first run's parameters — a
  bug that only appears once someone renders twice.
- An unknown `{placeholder}` in an `also` template is left **verbatim**, so the
  backend fails loudly, rather than emptied into a subtly wrong expression.
- Manifests are untrusted JSON, so the registry tolerates missing arrays: one
  malformed file must not break the menu for every other generator.
- **One queue for every generator type.** The machinery is identical — only the
  importer that lands the output differs — and the GPU semaphore has to serialize
  across all of them anyway. A per-type queue would be a second place for the same
  bug.
- `partial` is a **first-class group status**, not an error. Two of three variants
  succeeding still gives the user something to choose from; reporting it as failed
  would hide two usable results.
- A cancelled run is **not** a failed run. Failed runs are worth surfacing;
  cancelled ones are noise the user caused deliberately.
- A dying progress stream does **not** fail the run — the output may exist, so
  collection is still attempted.
- Group progress counts failed and cancelled runs as **settled**, or the bar sticks
  below 100% after everything finished and reads as a hang.
- The `GraphPatcher` is injected, so the queue is testable with a mock backend and
  no graph at all — which is exactly how the spec wants M9 verified before M10
  exists.

### ComfyUI backend rules (keep these)

- Patch order is fixed: defaults, then user values, then **preset pins last**, then
  the seed, then batch size. A preset's purpose is to _fix_ a parameter, so letting
  a stale user value win would make it a suggestion rather than a definition.
- `also` targets are patched alongside the primary pointer. Patching only the
  literal leaves a dependent expression computing from a stale value — the spec's
  fps example produces a clip of the wrong duration, which looks like a backend bug
  and is not.
- Asset parameters are **not** patched during the pure pass: the graph must
  reference the filename the _server_ assigns, which only exists after upload.
  `patchUploadedAsset` writes it afterwards, keeping the pure part pure and
  offline-testable.
- A required parameter with no value **throws** rather than submitting. Submitting
  would silently use whatever the graph author last saved.
- A ComfyUI 200 is **not** proof of acceptance: it answers 200 with a validation
  error body for a bad graph, so the absence of `prompt_id` is a rejection.
- Socket events are filtered by `prompt_id`. ComfyUI multiplexes every client onto
  one stream, so without it a second window's job drives this one's progress bar.
- Unknown socket event types are **ignored**, not treated as errors — ComfyUI adds
  new ones across versions and a server upgrade must not break generation.
- Cancel calls **both** `/interrupt` and `/queue` delete: ComfyUI distinguishes
  them, and `interrupt` alone would stop whatever is currently executing — possibly
  someone else's job — instead of removing a queued one.
- `collectLiterals` excludes connections (array-valued inputs) from the inspector.
  Offering one would produce a manifest that patches a value the graph immediately
  overwrites.

### Export rules (keep these)

- Export has **no plan builder of its own**. It calls `buildRenderPlan` exactly as
  the preview does; a second builder is precisely how the two would drift and break
  the WYSIWYG guarantee. A test asserts the two plans are identical for a frame.
- Frames stream over **one long-lived request** into ffmpeg's stdin. A 1080p RGBA
  frame is 8 MB and a three-minute export ~43 GB; that is fine through a pipe and
  hopeless as thousands of separate requests. Awaiting `drain` is what applies
  backpressure — without it the renderer buffers the whole export in memory.
- `-vf vflip` is **mandatory**: WebGL's framebuffer origin is bottom-left, every
  image format's is top-left, so `readPixels` output is upside down. Flipping in
  ffmpeg keeps the preview path free of a transform that exists only for export.
  A test decodes frame 0 and checks the pixels.
- `-pix_fmt yuv420p` is forced. ffmpeg would otherwise pick `yuv444p` for some
  inputs, producing a file that plays in VLC and shows black in QuickTime.
- Frame counting tracks **bytes**, not frames per chunk. HTTP chunk boundaries do
  not align with frame boundaries, so dividing each chunk discards the remainder
  and under-reports progress.
- stderr is drained **continuously**, and the drain task must be **referenced** —
  an unreferenced `asyncio.create_task` can be garbage collected mid-await, which
  reintroduces the pipe-full deadlock the drain exists to prevent.
- A cancelled export **deletes** its partial file: a truncated mp4 has no moov atom,
  will not play, and leaving one in `renders/` invites the user to try.

### Text layer rules (keep these)

- An animation preset is a **keyframe generator**, never a runtime behaviour.
  Applying one writes real, editable keyframes; nothing consults a preset at render
  time. The `TextAnimation` record only remembers what was applied. The spec is
  emphatic, and the practical payoff is that a user can apply "slide up" and then
  drag one marker to overshoot — impossible if the preset were interpreted.
- A preset animates toward the clip's **authored rest values**, not toward zero, or
  applying one would yank a deliberately offset title back to centre.
- Presets touch only the channels they need. `slide` must not pin opacity, or it
  would silently undo a hand-authored fade.
- `mergeGeneratedKeyframes` replaces only the generated _range_ and keeps keyframes
  outside it, so applying an in-animation cannot destroy an out-animation.
  `removeRange` identifies by range, not by id, because the user may have dragged
  the markers since.
- Typewriter reveals **in reading order**, one line completing before the next
  starts; revealing lines in parallel looks like a wipe, not typing. The count is
  **floored** so a character appears only once fully earned, with an explicit case
  at exactly 1 so the last character is not left hidden.
- The rasterization cache key covers **exactly** the non-animatable properties.
  Too narrow renders stale pixels; too wide re-rasterizes an animated clip every
  frame. `letterSpacing` and `lineHeight` are in the key despite being keyframable,
  because both change glyph layout — animating them is honestly slower.
- The key includes a **hash of the full text**, not just a length and a prefix:
  two long texts differing past the truncation point otherwise collide, and a
  colliding key renders the wrong text from cache.

### Verification harnesses (three of them now)

Each covers a property that cannot be checked in Vitest, and each exits non-zero
so it can gate a release:

| What                    | Serve                                             | Run                                       |
| ----------------------- | ------------------------------------------------- | ----------------------------------------- |
| Compositor pixels (17)  | `cd packages/compositor && npm run glcheck:serve` | `npm run glcheck`                         |
| Text rasterizer (19)    | `cd packages/text && npx vite --port 5201`        | `node packages/text/rastercheck/run.mjs`  |
| UI layout (screenshots) | `cd packages/ui && npx vite`                      | Playwright screenshot, compare to mockups |

### Effect and keyframe UI rules (keep these)

- Reordering the effect stack changes render output, so it is **not pointer-only**.
  Alt+Arrow moves a row; plain arrows stay free for moving between rows.
- Pointer reordering uses pointer events, not HTML5 drag-and-drop: native DnD cannot
  be keyboard-driven, gives no control over the drag image, and fights React's event
  model.
- The dragged row **dims in place** rather than following the pointer. A floating
  copy over a 340 px panel covers the very targets the user is aiming at.
- A shader error is surfaced on the row with its compiler message. It is the only
  feedback a shader author gets, and the spec requires it to be visible.
- A keyframe's easing badge sits **to the right of its marker**, because easing
  governs the segment _leaving_ it — and the **last marker gets no badge**, since its
  easing governs nothing.
- Drag handlers attach to the **window as well as the element**, and treat
  `setPointerCapture` as an enhancement inside a `try`. Capture is absent in some
  environments, and a marker that cannot be dragged at all is far worse than one that
  loses events when the pointer leaves.
- Always handle `pointercancel`, not just `pointerup`: an interrupted drag otherwise
  leaves the caller's undo gesture open, silently merging every later edit into it.

### Effect registry rules (keep these)

- A manifest parameter has **both** a `key` (document side) and a `uniform` (shader
  side), and they routinely differ (`amount` vs `u_amount`). Conflating them drops
  every such parameter — an effect that renders but ignores its controls. The
  compositor carries `paramKey` on each uniform declaration for exactly this.
- A manifest that fails validation is **kept with its reason**, never dropped. Same
  justification the spec gives for generators: a silently missing tool costs hours.
  A missing _shader file_ is a distinct status from a bad manifest, because the fixes
  differ.
- Validation is total — one broken file in `effects/` must not stop the other nine
  from loading. `createEffectRegistry` never throws, whatever the input.
- The registry hands the compositor a **narrow projection**: shader text, samplers,
  typed uniforms. Labels, ranges and groups stay behind, so the manifest format can
  grow without touching the render path.
- Non-numeric parameters are **forced** non-keyframable. Interpolating a boolean or a
  colour enum is meaningless and would put un-renderable keyframes in the document.
- A parameter with no declared default falls back to the **midpoint of its range**,
  not zero: an absent uniform reads as 0 in GLSL, which for a scale-like parameter
  hides the picture.
- Later manifests override earlier ones with the same id, so a project-local effect
  shadows a built-in — matching the precedence the spec gives project generators.
- Built-ins are inlined strings, not files. They still go through the identical
  manifest path (the registry cannot tell them apart), so this violates nothing in
  the spec's "no specific effect in code" rule; it only decides where bytes live, and
  it means a fresh install has a working menu.

### Audio rules (keep these)

- The mix plan covers a **time range**, not a frame. Web Audio schedules ahead of a
  hardware clock; per-frame scheduling produces an audible seam at every boundary.
- A clip straddling a block boundary is scheduled **once per block with the right
  offset**, never restarted, or its head replays at each boundary.
- The **audio clock drives the transport**, and the picture follows the playhead.
  `context.currentTime` is the only steady clock; driving audio from
  `requestAnimationFrame` drifts against the device.
- Keyframed gain is **sampled**, not emitted per keyframe: Web Audio ramps linearly
  between scheduled points, so an eased fade emitted as two points plays as a
  straight line.
- Clip and track gain **multiply**; clip and track pan **add** (then clamp). Panning
  a left clip on a left track must move further left, which multiplication would
  reverse.
- Pan uses an **equal-power** (sine/cosine) law. A linear law dips ~3 dB in the
  centre, audibly losing level as a source passes through it.
- A source whose buffer is not resident is **left unscheduled** and reported as
  `starved`; blocking would stall the whole graph for one missing file.
- Never schedule a start time in the past — it plays immediately at full level,
  turning a late decode into a stutter.
- Scrub plays a **short faded grain** of the loudest source only. Summing every
  layer while dragging is mush, and an unfaded grain clicks on every pointer move.
- The meter rises instantly and decays slowly (20 dB/s), and the clip indicator
  **latches** until reset — the user will not be looking at the instant it happened.

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
  containment _after_ resolution so a symlink pointing outside the project is
  caught too — textual validation alone would miss it. This duplicates the
  TypeScript check on purpose: the sidecar is a localhost HTTP server and must not
  assume its only caller is well behaved.
- ffmpeg is invoked with argument _lists_, never a shell, so a filename containing
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
  `packages/core/src/serialization/` is the _only_ place that knows both.
- The file optimizes for being read, diffed and hand-edited: frame rates as
  `"30000/1001"`, a constant parameter as a bare number, fields equal to their
  default omitted, two-space indent, trailing newline, never `null`.
- Every serializer omission must have a matching schema default. The
  "preserves a document using every field" round-trip test is what enforces this —
  extend that fixture whenever a field is added.
- Unknown keys are ignored on load (forward compatibility), but a file from a
  _newer_ `schemaVersion` is refused outright rather than best-effort parsed,
  because dropping fields and then saving would destroy work invisibly.
- `vWithDefault` substitutes for _absent_ values only. `vFallback` also swallows
  invalid ones and is restricted to closed vocabularies where degrading beats
  refusing (currently only keyframe easing).
- Migrations run on raw JSON _before_ validation, one step per version, and a
  released step is never edited.

### Resolved spec conflicts (do not re-litigate)

- **Keyframe time base.** `interfaces.md` §4.5 shows keyframe `t` in _seconds_;
  spec §7 mandates frame indices for every time value. **Frame indices win** —
  seconds reintroduce the drift the time layer exists to remove, and a keyframe off
  the frame grid cannot evaluate identically in preview and export. Seconds appear
  only in the UI and in shader uniforms.
- **Per-marker easing direction.** A keyframe's easing governs the segment
  _leaving_ it. Only that assignment makes `hold` mean "keep this value until the
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
- Comments explain _why_, not _what_. Tests name the behaviour and its rationale.

## Log

- 2026-08-08: Ledger created. Spec + interface contracts read, Claude Design
  mockups pulled (8 screens, 1920×1080) and design tokens extracted to
  `docs/design-tokens.md`.
- 2026-08-08: Workspace scaffolding (npm workspaces, strict TS, Vitest) +
  `@nos/core` time layer: exact rational arithmetic, `FrameRate`, `FrameIndex`/
  `FrameCount`, `FrameSpan` interval algebra, SMPTE timecode with real drop-frame
  support. 72 tests. Two bugs caught by the suite while writing it: `isDropFrameRate`
  compared 29.97 against 30 (29.97 is _below_ 30, so the canonical drop-frame rate
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
  an unknown easing degrades to linear, but `vWithDefault` only covers _absent_
  values, so a `"bezier"` easing failed the whole load. Added `vFallback` for that
  narrow case rather than loosening `vWithDefault`, which would have turned typos
  into silent data loss on the next save.
- 2026-08-08: `@nos/media` contracts + folder tree, and the sidecar foundation
  (`paths.py`, `ffmpeg.py`). 281 tests. Ran the ffmpeg command builders against
  real ffmpeg on synthesized landscape and portrait sources rather than trusting
  that they read correctly — which caught a naming bug: `ProxySpec.maxEdge` was
  documented as "long-edge pixels", but portrait 1080×1920 came out 720×**1280**,
  exceeding the supposed cap. The filter was right for `1080p` semantics (what the
  spec asks for); the _name_ was the lie, and it would only ever have shown up on
  vertical footage. Renamed to `shortEdge` across both languages.
- 2026-08-08: Sidecar HTTP layer complete — FastAPI app, content-hash cache
  (memoized by `(size, mtime_ns)` and persisted, so reopening a project rehashes
  nothing), `.peaks` binary format, loopback entry point. 62 Python tests, all
  against real ffmpeg and real files; nothing mocked, because the sidecar's whole
  job is driving ffmpeg correctly and refusing paths it shouldn't read — neither
  property survives stubbing. Three bugs the tests caught: the FastAPI closure
  dependency issue (every request 422'd), the `.partial` extension breaking
  ffmpeg's container inference (exit 234), and one wrong _test_ expectation — I
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

  Then verified it _visually_ in a real browser via a Playwright screenshot, which
  caught a deviation jsdom could not: `project.json` had sunk to the bottom of the
  tree, because the general rule puts directories before files. The mockups place it
  first — it is the file that _is_ the project. Fixed with a root-scoped pin; the
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

  One failure was again a wrong _test_: I asserted `start + duration === 150` after
  an end-edge snap to a candidate at 100, which is arithmetically impossible — the
  snapped edge lands _on_ the candidate. The implementation was right and an earlier
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

  Verified afterwards: all 7 programs compile _and_ link, including a
  gl-transitions shader that reads `ratio`, one with its own `uniform` line, a
  masked blur with a `bool`, and one using all four spec-mandated built-ins. The
  passthrough program also actually draws — a 1×1 source texture reads back exactly
  at the centre pixel, proving the attribute-free fullscreen triangle works.

- 2026-08-08: WebGL2 executor complete. Verified by **pixel read-back in a real
  driver** — 16 assertions covering: a bare layer reproducing its source; a pass
  actually running with its uniform set; two passes chaining through the ping-pong
  (red halved twice reads 64, where a target reading its own output would read 128);
  the mask sampler bound to its own unit; all four built-in uniforms set from the
  layer; a broken shader degrading to passthrough with the picture intact _and_ its
  diagnostic correctly rebased to authored line 1; source-over opacity blending;
  layer order; a gl-transitions wipe at both ends of its progress; a missing texture
  skipping only its own layer; and zero pool leaks after 30 frames.

  One assertion failed first time and it was my _test_, not the compositor: the mask
  shader multiplied alpha as well as RGB, so the read-back depended on two effects at
  once. Also strengthened the mask fixture from white to mid-grey — against a red
  source, a white mask cannot distinguish "bound correctly" from "bound to the
  source texture", since red's own R channel is 1.0 either way.

- 2026-08-08: `@nos/audio` closes Phase 3. Mix planning follows the compositor's
  pattern — a pure plan shared by playback and export, so an exported mix cannot
  diverge from what was auditioned. 47 tests, all green first run. Rules above.

  **Committed** the whole foundation to branch `build/foundation` (local only, not
  pushed). I had flagged the absence of commits twice; with ten packages and 680
  tests of uncommitted work this was the routine protective call to make rather
  than leave the tree bare.

- 2026-08-08: `@nos/effects` — manifest schema, validating registry, built-in
  library. 36 tests.

  Reading `interfaces.md` §4 closely caught a **latent bug in the compositor**: an
  effect parameter carries both a `key` and a `uniform`, and the plan builder assumed
  they were the same string. Every manifest using the spec's own convention
  (`amount` → `u_amount`) would have had its parameters silently dropped — an effect
  that renders but ignores its controls, with nothing in any log. Fixed by carrying
  `paramKey` on each uniform declaration, and covered by a test that asserts the
  emitted uniform is keyed by the _shader_ name.

  Extended the GL check to compile every shipped built-in, since a syntax error in
  one is a defect every user meets on first run. 17/17 now.

  Two of my own harness mistakes here, both worth remembering: `manifest(json,
undefined)` triggers a JavaScript _default parameter_ rather than overriding it, so
  a "missing shader" test silently supplied one; and appending `results.builtins`
  overwrote an existing key of that name, turning a passing pixel assertion into a
  failing one.

- 2026-08-08: **Phase 4 closed (M5, M6).** Effect stack and keyframe lane UI, 54
  tests, screenshot-verified against mockup 1b.

  A failing test exposed a genuine robustness gap rather than a test artifact: the
  keyframe drag handler called `setPointerCapture` unguarded, so in any environment
  lacking it the handler threw and the marker became undraggable. Rewritten to attach
  listeners to the window as well as the element, with capture as a guarded
  enhancement — and a test now asserts a drag starts where capture is unavailable.

- 2026-08-08: `@nos/text` — rasterization cache contracts, animation presets as
  keyframe generators, typewriter advance mechanism. 86 tests.

  A test caught a **real cache collision**: the key truncated the text to 48
  characters and relied on the length to disambiguate, so two long texts differing
  only past that point produced identical keys — the cache would render the wrong
  text, with nothing in the symptom pointing at the cause. Added an FNV-1a hash of
  the full string while keeping the readable prefix, plus tests for a
  differs-in-the-middle case and a transposition.

- 2026-08-08: **Phase 5 closed (M7).** Canvas 2D rasterizer and the raster cache,
  verified against a real font engine — 19 assertions covering advance/width
  agreement, wrapping inside the box, letter spacing, alignment, baseline spacing,
  outline and shadow ink, and the typewriter clipping exactly on a glyph boundary.

  Layout code takes injected measurement functions rather than measuring itself.
  That is not indirection for its own sake: preview and export must reveal the same
  characters at the same time, and sharing the layout while injecting only the
  measurement makes that structural rather than coincidental.

  Drawing goes character by character when letter spacing is non-zero, and
  measurement sums per character to match. `ctx.letterSpacing` and a whole-string
  `measureText` both apply kerning that per-character drawing does not, so the
  advances would disagree with the pixels by a pixel per glyph — enough for the
  typewriter to clip mid-stroke.

  One harness assertion was wrong, not the code: `set` marks an entry touched, so a
  just-created texture survives the first sweep. That is deliberate — evicting
  before first use would make a clip re-rasterize on every sweep tick — and the test
  now asserts both halves of the behaviour.

- 2026-08-08: Export encoder (M8). 34 TypeScript tests + 17 Python tests against
  real ffmpeg — a playable mp4, correct dimensions and frame count, the exact
  rational frame rate surviving, audio muxing, H.265, and cancellation removing the
  partial file.

  The orientation test earns its keep: it decodes frame 0 back to RGBA and checks
  which half is which colour. Without `-vf vflip` an export is upside down, and that
  is invisible in the preview — it would only be discovered in the delivered file.

  Two real bugs found here. A test caught the frame counter dividing **per chunk**,
  so integer division discarded the remainder every time and progress under-reported
  on any streamed export (three chunks of 3.33 frames counted 9, not 10); it now
  tracks bytes. And `ruff` caught RUF006 on my own defensive code: the stderr drain
  task was created without a reference, so it could be garbage collected mid-await
  and cause exactly the pipe-full encoder deadlock it was written to prevent.

- 2026-08-08: Generator manifest validator and registry. 25 tests, the most valuable
  of which validate **the spec's own example manifests against the real ComfyUI
  graphs** in `docs/comfy/` — every pointer in `interfaces.md` §2.1 and §2.2
  resolves, including the `also` template target that a single-pointer check would
  miss. That is a much stronger statement than any hand-written fixture: it proves
  the pointer format and node-id conventions against files written for the project,
  not for the test.

  A test fixture missing `presets` surfaced a robustness gap rather than just a typo:
  manifests arrive as untrusted JSON, so the registry now tolerates missing arrays.
  One malformed file must not break the menu for every other generator — the same
  rule the effect registry already follows.

- 2026-08-08: Job queue and mock backend. 31 queue tests, all green first run, and
  the generator framework now works end to end **without ComfyUI or a GPU** — which
  is the separation the spec asks for between M9 and M10.

  The mock backend is deliberately capable of misbehaving: configurable submit and
  collect failures, delays and cancellation. A mock that only ever succeeds would
  leave the interesting half of the queue untested, and the queue's error paths are
  most of its value. `failSubmitOn` takes specific run indices rather than a
  fail-everything switch, because the case worth testing is one variant of three
  failing — which is what exercises the `partial` status.

- 2026-08-08: ComfyUI backend (M10). 43 tests. Graph patching is pure and verified
  by writing into the **real** supplied graphs and reading the values back —
  including the `also` template substituting fps into the length expression twice,
  and a preset pin overriding a user value. A hand-written fixture would only have
  proved the patcher self-consistent.

  The protocol tests use a scripted transport rather than a live server, which is
  what lets them assert the awkward parts: that a ComfyUI 200 with no `prompt_id` is
  a rejection, that socket events for another prompt are filtered out, that an
  unknown event type is ignored rather than fatal, and that the socket is closed
  even when the consumer breaks out of `for await` early.

  Also resolved the recurring `exactOptionalPropertyTypes` friction properly:
  component callback props are now declared `(() => void) | undefined` rather than
  `?: () => void`, because a parent forwarding its own optional handler is the normal
  case and conditional spreads at every call site were pure noise.

- 2026-08-08: Phase 7/8 UI completed. The generator panel, the variant picker and
  the manifest inspector are all pure renderings of a value — a `RegistryRecord`,
  a `VariantSelection`, a `ManifestDraft` — with the logic living in
  `@nos/generators` where it is testable without a DOM. The rule the panel exists
  to hold is worth restating: **nothing may branch on a generator id.** The switch
  is over declared parameter _types_; a new generator is a JSON file and no code.

  Two bugs the tests found. `toManifest` branded the id, so previewing a draft
  whose id was still empty threw and took the whole inspector down at exactly the
  moment the user was typing it — split into `draftManifestJson` (total) and
  `toManifest` (validating, at the boundary). And a draft parameter identified by
  its pointer became unaddressable the moment its pointer was cleared, which is
  the state the spec's unbound manifests are _written in_; parameters now carry a
  stable id separate from the binding.

- 2026-08-08: A real generator library in `generators/`. Manifest files needed a
  parser first: the on-disk form is the spec's snake_case, the runtime form is
  camelCase, and one module owns both so the naming leaks into neither side. Five
  manifests now cover every supplied graph, and `library.test.ts` validates each
  against **its own** graph — not the union of all of them, since a `requires`
  entry naming a class only some other graph uses would otherwise pass here and
  fail on the first run.

  The coherence checks are the interesting half: defaults inside their declared
  ranges, preset pins naming parameters that exist, no two parameters bound to one
  pointer, and a seed wherever `default_variants > 1`. Each of those is a mistake
  that produces a manifest which loads cleanly and behaves wrongly.

- 2026-08-08: M11, the mask pipeline. The design rule from the spec is that a mask
  is an asset type like any other and reaches an effect through a declared `mask`
  sampler slot, so `@nos/masks` knows nothing about SAM 2 — the segmenter is an
  interface — and the compositor knows nothing about how a mask was produced.

  RLE follows **COCO's column-major layout** rather than anything private, so
  masks from any SAM-family tool decode unchanged. It is implemented twice, in
  TypeScript and Python, and both suites are pinned to one shared fixture: a
  row/column swap is invisible in every square test and produces a transposed mask
  with nothing in any log. The GL harness closes the loop by rendering a decoded
  left-half mask over a red source on a real driver and reading pixels back — and
  a negative control confirmed those assertions actually fail when the mask is
  transposed, rather than passing for a coincidental reason.

  Two decisions worth recording. Partial results survive everywhere: a propagation
  that fails at frame 300 of 500 keeps its 300 frames, in the session model, in the
  service and through a cancel. And an unavailable engine is reported with a
  concrete, actionable reason rather than hidden — the same rule the generator
  registry follows, because SAM 2 is an optional install and its absence has to be
  legible instead of looking like a missing feature.

- 2026-08-08: Phase 10, hardening. The end-to-end smoke test earns its place
  immediately: it caught that `buildSelection` produced **one** candidate per
  _run_, while the spec's own audio manifest is batched — three variants arrive
  as one submit with three outputs. The panel would have shown a single variant
  and left the other two in `generated/` with no way to reach them. Every
  package's own tests passed throughout; only a test crossing the queue, the
  manifest and the staging model could see it.

  That is the argument for the smoke test in one sentence, and the reason its
  assertions are written as _seams_ rather than as behaviour: a backend output
  becomes a clip the compositor will draw, the clip the editing layer moved is the
  clip the mix plan hears, and the whole thing survives the project file.

  The performance guard pairs every wall-clock threshold with a structural
  assertion — plan size proportional to the frame rather than the document,
  untouched tracks kept by reference — because a timing check alone is noisy on a
  loaded machine and says nothing about _why_ it regressed. On a 2000-clip project
  the structural claims are what fail first.

- 2026-08-08: The Electron shell. Its job is deliberately three things — a window,
  the project folder, the sidecar's lifetime — and everything else stays in
  packages that have never imported Electron, which is why they have been testable
  in Node from M1.

  Two security decisions are worth stating because both are easy to erode by
  accident. The preload exposes **eight named methods**, not a generic
  `invoke(channel, payload)`: a generic bridge hands the whole main-process surface
  to any renderer bug that lets an attacker choose the channel name, and the named
  list is the entire trust boundary in one reviewable place. And the sidecar token
  travels in the **environment**, never in argv — a command line is world-readable
  through the process table on every platform this runs on. A test asserts the
  token does not appear in the arguments, because that is the kind of thing a
  refactor reintroduces silently.

  Readiness is polled on `/health` rather than parsed from stdout. A readiness line
  printed before the socket is actually bound is a race that shows up once a week
  on a slow machine and never on the developer's.

  Verified by launching it: the window paints the editor, `window.require` is
  `undefined`, the bridge exposes exactly its eight methods, and no page errors are
  raised.

- 2026-08-08: `npm run verify` — format, lint, typecheck and the full suite — is
  green: **1339 TypeScript tests, 136 Python tests, 22/22 compositor GL assertions
  and 19/19 rasterizer assertions.** Every phase of the plan is checked.

- 2026-08-08: The shell wired up, and two bugs only a running application could
  show.

  The first was reported by the app itself: "ComfyUI is unreachable at
  http://127.0.0.1:8188" while `curl` got a 200 from that exact URL. ComfyUI sends
  no CORS headers, so a renderer loaded from `file://` cannot reach it at all —
  and the failure is indistinguishable from the server being down. Backend HTTP
  now goes through the main process, which has no CORS to satisfy and keeps
  basic-auth credentials out of the page. The WebSocket stays in the renderer
  because WebSockets are not subject to CORS. The ComfyUI backend needed no change
  at all: it takes an injected transport, which is precisely what that design was
  for.

  The second was visual. Every panel sized itself to the mockups' 340 px inspector
  width, and under the default `content-box` that width excludes padding — so each
  overflowed its column by exactly its padding and clipped the status badge, the
  seed lock and the Generate button off the right edge. Every unit test passed
  throughout, because none of them lays a panel out inside a sized column. This is
  the third time in this project that a screenshot has caught what the suite
  structurally could not.

  With both fixed, the running application validates all five shipped manifests
  against the live ComfyUI (1102 node classes) and renders each generator's
  parameters, presets and capability badges from its JSON alone — which is the
  framework's central claim, demonstrated rather than asserted.

- 2026-08-08: The preview surface. It is the same compositor the export uses —
  that is the spec's WYSIWYG rule and the reason there is one implementation
  rather than a fast path and a correct one. This component supplies the two
  things it cannot get itself: a GL context, and textures for decoded frames.

  Decoding is best-effort by design. A layer whose frame has not arrived is
  skipped and *counted*, never waited for: a preview that blocks on a seek turns a
  slow decode into a frozen window, and `layersSkipped` is what tells the user a
  frame is still coming rather than leaving them looking at unexplained black.

  Running it surfaced a real gap in the render-plan contract. The plan's video
  source carried `sourceFrame` "in the source's own rate" but not the rate itself,
  so the executor had to guess — and a 24 fps clip on a 30 fps timeline is seeked
  25% away from the right moment, an error that grows with the clip and appears
  nowhere in the plan. `sourceRate` is now on the plan, with a test.

  And a CSS one worth recording because it is easy to repeat: `max-width` and
  `max-height` constrain independently, so a 16:9 canvas in a 2:1 box is squashed
  rather than letterboxed. `aspect-ratio` is what keeps it honest. A preview that
  misreports framing is worse than no preview in an editor.

- 2026-08-08: Dragging, trimming and the transport — the two gestures that make
  the editor an editor rather than a viewer.

  The drag holds to the rule the editing layer was designed for: every pointer
  move re-applies the operation to the document **as it was when the gesture
  began**, so the drag is a preview and the store records exactly one entry on
  release. Applying deltas cumulatively instead would accumulate rounding at every
  event, and a slow drag would end somewhere different from a fast one covering
  the same distance. Verified in the running app: the clip follows to +200 frames,
  stays on release, and one undo returns it exactly.

  The transport advances from a wall clock rather than counting frames. A `+1` per
  animation frame drifts as soon as a render exceeds a frame's budget — slowly on
  a fast machine, obviously on a slow one, silently on both — while deriving the
  frame from elapsed time makes a dropped frame *dropped* rather than accumulated
  as error. That is what will keep audio aligned when the engine is connected.
  Verified: one second of playback advances exactly 30 frames at 30 fps.

  The timecode readout uses the core formatter rather than a local one, because
  drop-frame is precisely the rule that is wrong in every hand-rolled timecode.
