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
- [x] `@nos/ui`: the shadcn registry (Base UI) and the panels composed from it. Was a
      hand-built token layer until issue #21; see `docs/design-tokens.md`. Primitives,
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
**2376 TypeScript tests + 147 Python tests passing; `tsc --build` clean, `ruff` clean,
22/22 compositor GL assertions, 19/19 text rasterizer assertions.**

Branch `build/foundation`, and `refactor/shadcn-baseui` on top of it (pushed).

### A caution about the check marks above

Every box in this plan was ticked while two capabilities the spec requires were **not reachable from
the application**, and the difference was invisible from here: both had an engine, tests, and no
control. "The engine is done" and "a user can do it" are different claims, and this document was only
ever tracking the first.

- **A keyframe's value could not be changed.** Markers could be created, dragged in time, cycled
  through easings and deleted. The inspector disables a parameter's slider once it is animated —
  correctly — so between the two, a number became unreachable the moment it was keyframed. Fading a
  title out was not expressible. Fixed: `editKeyframe` in `@nos/core`, a field in the lane.
- **A clip's framing could not be set.** The compositor has evaluated x, y, scale, rotation and
  opacity per frame since M4 and the shader honours all five; nothing could write one, so every clip
  sat centred, unscaled and fully opaque forever. Fixed: `@nos/editing/clip-transform` and a framing
  section in the clip inspector.
- **A title's outline and shadow could not be set.** Rasterized since M7, including the care taken
  not to draw the shadow twice — in a code path that had never run, because nothing could switch an
  outline on. Fixed: the text inspector now offers every field `TextContent` carries.
- **A mask could not reach an effect.** The whole of M11 terminated in a file nothing could read: the
  segmenter produced masks, `EffectInstance` could name one, the plan carried the id, the compositor
  asked for a texture — and the renderer answered `undefined`, unconditionally. Nothing could set
  `EffectInstance.mask` either, so the built-in Background Blur, which the spec names as *its own*
  example of the mask system, declared the slot and could never receive one. Fixed: a binding control
  for any effect declaring the `mask` sampler, and `mask-source.ts` resolving a bound id to the frame
  being drawn.
- **A note was never shown.** §4 asks the browser to display markdown and reserves `notes/` for it;
  the browser showed the filename. Fixed: `@nos/media/notes/markdown` parses to a structure — never to
  an HTML string — and `NoteView` renders it.
- **Every title was silently absent from every export.** Not an unreachable feature but a *wrong
  result*: the export built its own plan without a text cache key and never called `registerText`, so
  the plan asked for titles by clip id while the rasterizer stored them by content hash. The preview
  showed the title; the delivered file did not. Fixed by `frame-render.ts`, which both paths now go
  through — one compositor turns out to be necessary and not sufficient, because the two *preparations*
  had drifted.
- **Masks were never written to disk.** The content-addressed cache existed and was never given a
  storage, so segmentation lived in React state alone and a reopened project rendered a bound effect
  unmasked. Fixed: `mask-storage.ts` over the bridge, written when a run finishes.

Two more, found only by running it:

- **Opening a project waited fifteen seconds for the sidecar.** `openFolder` awaited `startSidecar`,
  so on a machine without the sidecar's dependencies every launch showed "no project open" for the
  whole timeout. It starts in the background now and reports on `IPC_EVENTS.sidecarStatus`.
- **The last project was remembered in `localStorage` on a `file://` origin**, which Chromium does
  not guarantee to persist — it survived some restarts here and not others. It lives in `userData`
  now, written by the main process inside `openFolder`.

### The check that actually finds these

Two of the five were unreachable UI and three were wrong output. Grepping for a document field with no
writer finds the first kind. The second needs a different question, and it is the one worth asking
here: **does the export do exactly what the preview does?** Anywhere the two paths are written
separately, they will diverge, and the divergence is invisible until a render finishes.

And the third kind is found by neither: **launch it and watch the clock.** A fifteen-second stall and
a setting that persists only sometimes are both invisible to every test in this repository, because
each component behaves correctly in isolation.

To run it against a fixture rather than a folder picker: the shell remembers the last project in
`~/.config/@nos/desktop/session.json`, so writing a path there and launching opens it. Give
`--remote-debugging-port` a port well clear of anything else on the machine — the sidecar takes an
ephemeral one, but other tooling may not.

One field still has no writer and is left deliberately: `clip.speed`. The compositor and the audio
graph both read it and `attributes` copies it, but the spec's §6.1 does not ask for a speed control,
so building one would be widening the scope rather than closing a gap.

The lesson worth keeping: when this plan says a milestone is done, check that a *user* can reach it,
not that the package exports it. Grep for a document field that nothing writes.

Packages: `@nos/core`, `@nos/media` (contracts), `@nos/sidecar-client`
(HTTP implementation), `@nos/editing` (document transforms), `@nos/compositor`,
`@nos/effects`, `@nos/audio`, `@nos/text`, `@nos/export`, `@nos/generators`,
`@nos/backend-comfyui`, `@nos/masks`, `@nos/ui` (the shadcn registry + composed panels),
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

**Audio playback and the generative loop are closed.** Playback drives the audio
engine (verified: the file is fetched and decoded, playback advances at exactly
30 fps), and an accepted variant lands on the timeline as a clip carrying its
provenance (verified: generate → keep → a third clip appears, marked generated).

**Export and the effect stack are wired.** Exporting from the dialog produces a
playable file through the same compositor the preview uses (verified: H.264
1920×1080, 120 frames, exactly 4.000000 s, correct pixels), and selecting a clip
gives the manifest-driven effect stack with live parameters (verified: adding
Film Grain renders one pass with visible grain).

**Every feature in the spec is built, wired into the shell, and verified in the
running application.** Keyframe editing is in — one lane per animated parameter,
one drag one undo step (verified: a marker dragged from frame 300 to 420 returns
to 300 with a single undo).

Export throughput is fixed, and the fix came from measurement rather than
intuition: frames now leave through the main process, and a 1080p 120-frame
export went from about **85 s to 5.1 s**.

**Every component in `@nos/ui` is now mounted in the shell**, including the
manifest inspector — so a new generative capability really is a JSON file
authored from inside the application, with no code. Verified against a real
ComfyUI graph.

**Text clips are in**: created on the text track, styled through an inspector,
rasterized into the compositor, and animated by presets that write ordinary
keyframes into lanes the user can edit. Verified in the running application.

**Transitions are in** — the last spec feature that had an engine but no way in.
Created across a cut from the clip inspector, consuming handles so the sequence
never changes length, removed with an exact round trip. Verified in the running
application: a crossfade overlaps the clips by exactly its duration and the plan
builds a transition item.

**Media import** closes the loop that mattered most: double-clicking a file in the
browser probes it and lands it on the timeline, a video carrying audio becoming
the linked pair the spec describes. Before this, media could only reach the
timeline by editing `project.json` by hand.

Every feature in the spec is now built, reachable from the shell, and verified in
the running application — and the shell itself is unit-tested rather than covered
only by end-to-end probes.

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
  accident. The preload exposes a **fixed list of named methods**, not a generic
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
  `undefined`, the bridge exposes exactly the methods the contract names, and no
  page errors are raised. (The list has grown as capabilities landed — frame
  streaming for export, the recovery channels for autosave — but never as a generic
  escape hatch, which is the property that matters.)

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

- 2026-08-08: Audio playback, and closing the generative loop.

  The engine was already written and tested; what it needed from the shell was an
  `AudioContext` and decoded buffers. The buffer cache holds three properties the
  engine depends on and states each: one decode per asset ever (the scheduler asks
  twenty times a second, so without in-flight deduplication that is twenty
  concurrent decodes of one file), a bounded footprint evicted least-recently-used
  (a stereo minute is ~23 MB decoded), and failures as *values* — a rejected
  promise inside a scheduler tick takes the whole playback loop with it and
  silences every other track.

  The audio clock is authoritative during playback, per the engine's own contract,
  but only when there is audio: a video-only timeline has nothing to lock to, and
  deferring to an engine that will never tick would leave the playhead at zero.

  `insertGenerated` is the loop's last step, and it is two rules. A declared-length
  output lands exactly where its placeholder stood and reports a collision. A
  discovered-length output lands from the playhead and **never shifts anything** —
  it moves to a free track of its kind, creating one if it must — because a
  narration that rearranged a video cut would be the most destructive thing this
  feature could do.

  Two things running it exposed. The run button swallowed enqueue failures, so a
  click could do nothing and say nothing — the exact failure this project treats as
  a defect everywhere else. And the variant panel said "generating 1 variant" for a
  **batched** submit carrying three seeds: one submit is one candidate while it
  runs, so the count had to come from what was *requested*, not from what is in
  flight.

- 2026-08-08: Export and the effect stack — the last two subsystems that were
  built and tested but unreachable from the shell.

  The export runs the **same compositor** on the **same decoded frames** as the
  preview, into an offscreen 8-bit target whose pixels stream to the sidecar's
  ffmpeg. The decoder is now shared for exactly the reason the compositor always
  was: two of them would eventually disagree about which frame a source time lands
  on, and the delivered file would differ from what the user approved. They differ
  in one respect only — the preview never waits for a seek and the export always
  does, because a skipped layer is a momentary blank on screen and a missing shot
  in a deliverable.

  Two details that are not obvious and would each have cost an afternoon. Frames
  are batched to a byte budget rather than sent individually: a 1080p RGBA frame is
  8 MB, and per-frame requests spend the export in overhead while awaiting each
  batch gives backpressure for free. And the readback target is RGBA8 rather than
  the pool's RGBA16F, because `readPixels(UNSIGNED_BYTE)` from a half-float
  attachment is not universally supported — the pool's format is right for
  intermediate passes and wrong for the one buffer that leaves the GPU.

  The clip inspector renders from the effect manifest, like everything else here.
  The picker lists broken effects with their compiler message rather than hiding
  them, because an effect missing from the list is indistinguishable from one that
  was never installed. Verified end to end: exporting produces a 4.000000-second
  H.264 file with the composited pixels upright, and adding Film Grain shows its
  declared controls and renders visibly.

- 2026-08-08: Keyframe editing, and a measurement that refuted this ledger.

  The lanes follow §6.4: one per animated parameter, markers dragged horizontally,
  and **one drag is one undo step** — the drag holds a preview document that never
  reaches the store and commits once on release, the same pattern clip dragging
  uses. Animating is an explicit act rather than something that happens on first
  edit, and adding a keyframe mid-curve takes the parameter's value *at that
  frame*, so the gesture makes an instant editable without changing what the
  animation already does.

  The more useful entry is the export measurement. This ledger recorded that the
  export was slow "because every frame costs a `<video>` seek", and that WebCodecs
  was the fix. Instrumenting the run — as a first-class result, because "the export
  is slow" has four plausible causes and guessing costs a day — gave decode **3%**,
  render **1%**, readback **3%**, upload **78%**. A direct probe confirmed it: a
  seek is 2.4 ms and a texture upload 0.1 ms per 1080p frame, nowhere near the
  700 ms per frame the export was spending. The assumption was wrong, and it was
  written down confidently enough that it would have cost a day of WebCodecs work.

  The upload is now pipelined so rendering does not stop while ffmpeg consumes a
  batch, which is a real improvement wherever there are many batches. It cannot
  raise the ceiling, though: the ingest path moves about 12 MB/s over loopback HTTP
  and a 1080p frame is 8 MB. Moving frames to the sidecar over a pipe from the main
  process, rather than as HTTP request bodies, is the next step — and now it is the
  step the evidence points at rather than the one that sounded plausible.

- 2026-08-08: The export is roughly **17× faster**, and the whole episode is worth
  keeping as a record of how not to guess.

  The first hypothesis, written into this ledger with some confidence, was that
  decoding dominated and WebCodecs was the answer. Instrumenting the run gave
  decode **3%**, render **1%**, readback **3%**, upload **78%** — so that was
  wrong. The second hypothesis was that the sidecar's ingest was the ceiling, at
  the ~12 MB/s the numbers implied. That was wrong too: `curl` posted 16 MB to the
  same endpoint in **0.02 s**, about 800 MB/s.

  What was actually slow was `fetch` **in the renderer**. Chromium copies a large
  request body across its network-service boundary, and a 16 MB body cost roughly
  1.3 s from a page versus 0.02 s from Node. The frames now go over IPC to the main
  process, which posts them with Node's client. A 1080p 120-frame export went from
  about 85 s to **5.1 s**; a 640×360 30-frame one from 2.9 s to **0.3 s**. Output
  byte-identical in shape: 1920×1080, 120 frames, exactly 4.000000 s.

  Two hypotheses, both plausible, both wrong, and each would have cost a day to
  implement. Each was refuted in minutes by a measurement that took one command.
  The timing breakdown stays in the product for that reason — it is not debug
  scaffolding, it is the thing that makes the next report actionable.

- 2026-08-08: The manifest inspector is mounted, which was the last component in
  `@nos/ui` that existed and was tested but could not be reached from the running
  application.

  It matters more than a wiring task usually would, because it is the screen that
  makes the framework's central claim true rather than merely architectural. The
  loop was verified end to end against a real graph: picking
  `fish_s2_voiceclone_hu_workflow.json` listed **20 literal inputs**, ticking one
  made it a parameter, the draft validated clean, saving wrote
  `authored_tts.manifest.json` into the project's `generators/` folder, and the
  library reloaded with `authored_tts` in the generator list beside the five
  shipped ones.

  A new generative capability, created from a ComfyUI export, inside the
  application, with no code written.

- 2026-08-08: Text clips — the last spec feature with an engine but no way in.

  `@nos/text` already had the rasterizer, the presets and the typewriter advance
  mechanism. What was missing was creation, a properties panel, and the step that
  turns a raster into a texture the compositor can sample. The presets keep the
  rule that makes them worth having: **a preset generates keyframes**, and they
  appear in the lane as ordinary markers. So the keyframe lanes had to grow beyond
  effect parameters to cover the clip's own transform and a text clip's `reveal`
  channel — `reveal` is separate from the transform because typewriter changes the
  *number of visible glyphs*, which no transform can express.

  Two bugs that only running it could find, both of the silent kind.

  A title rasterized correctly, uploaded without complaint, and was **invisible**.
  This GL backend refuses an `OffscreenCanvas` as a texture source without raising
  anything the caller sees: the texture existed and sampled fully transparent, so
  the layer was not even counted as skipped. A DOM canvas fixes it; a `getError()`
  check after the upload and an ink-coverage assertion on the raster mean the same
  class of failure now produces a sentence instead of a blank frame.

  And the first working title filled the whole screen, because the compositor draws
  every layer as a fullscreen quad — correct for video, which fills the frame, and
  wrong for a title, whose `size` control consequently meant nothing. The raster is
  now composed onto a frame-sized surface at its natural pixel size, which keeps
  the compositor's model intact and makes the size a real pixel size.

- 2026-08-08: Transitions, and unit tests for the shell.

  A transition is its own entity rather than an effect on either clip because it
  **samples both**, and its `progress` is computed by the engine from the overlap —
  the spec forbids exposing that as a keyframable parameter, since the engine would
  overwrite whatever was authored. Which means it needs a *real* overlap, and two
  clips butted at a cut have none. Creating one therefore consumes handles: the
  outgoing clip extends past the cut and the incoming one starts before it, half
  the duration each. That is why `SourceBounds` matters here — a clip with no
  material beyond its out-point cannot be extended, and the honest answer is a
  rejection naming how many frames are missing rather than a dissolve that holds a
  frozen frame. The sequence length never changes.

  One design decision worth recording: adding a transition where one already exists
  **replaces** it. Without that the clips are already overlapping on the second
  call, the adjacency check rejects it, and a user who wanted a different dissolve
  has no way to ask for one. A test asserts the add/remove round trip returns the
  original document exactly.

  Also closed the gap this ledger flagged last time: the shell's pure logic had no
  unit tests, only end-to-end probes. The library loader is the most valuable of
  them, because its stated property — one malformed manifest must not stop the
  others — is the kind that fails silently and looks like a generator was never
  installed.

- 2026-08-08: Component tests for the shell — the last weakness this ledger named.

  `App`'s children were covered only by driving the running application, which
  catches integration failures and says nothing about behaviour. These pin the
  parts with consequences.

  `TextInspector`, because "a preset writes keyframes into the channels it touches
  and no others" is the claim the panel makes in its own hint text, and because
  typewriter has to land on `reveal` rather than on the transform. `ClipInspector`,
  because the transition controls must be disabled where there is no neighbour and
  must *report* a rejection rather than silently doing nothing. `KeyframeLanes`,
  because a lane has to appear for a clip's own transform as well as for effect
  parameters, and because clip-relative positions are converted in exactly one
  place — a clip starting at frame 60 shows its frame-0 marker at 60.

  One of these replaced a first draft that could pass without asserting anything,
  because jsdom gives every element a zero-sized box and the lane converts a click
  offset into a frame. A test with an `if (nothing happened) return` in it is worse
  than no test: it reports success for the case it was written to catch. Stating
  the box makes the conversion testable instead of skipped.

  **1480 TypeScript tests, 136 Python tests, 22/22 GL assertions, 19/19 rasterizer
  assertions.**

- 2026-08-08: Media import. Reviewing the spec against the shell found the gap that
  mattered most and had been easy to miss: `onActivate` on the media browser was a
  no-op, so media could only reach the timeline by editing `project.json` by hand.
  Every other feature was reachable, which is exactly why this one was invisible.

  The probe runs first, because what a file *is* decides everything that follows:
  its length, which track it belongs on, and whether it becomes one clip or two.
  Guessing from the extension would put a silent `.mp4` on two tracks and read a
  24 fps clip at the project's rate.

  The spec's rule is honoured explicitly — a video whose file carries audio becomes
  a video clip with a **linked** audio clip beneath it — and the link is *recorded*
  rather than inferred from matching asset paths, because two cuts of the same file
  must not appear linked. Inferring it would tie together clips the user
  deliberately separated.

  Placement lands at the playhead when it is clear and after the material
  otherwise. The editing layer refuses a collision, as it does for every other
  operation; finding the first free frame first is what turns that refusal into the
  result the user wanted rather than an error they have to resolve by hand.

- 2026-08-08: Filmstrips and waveforms on clips. The `stripUrls` prop had been
  wired to nothing since the timeline was built, so every clip was a flat
  rectangle — the sidecar produced strips that nothing displayed.

  Wiring it exposed a contract gap worth more than the feature. A filmstrip covers
  a whole **asset**, but a clip shows a **range** of one, so the image can only be
  placed if its span is known — and the renderer cannot recover that: the requested
  rate is not what came back, because a long source is capped to 900 columns and
  resampled. So `/media/derive` now reports what a filmstrip actually spans, on the
  reused path as well as the fresh one, and stores it in a dotted sibling file so a
  cache hit stays a cache hit. A strip whose span is unknown is **not drawn at
  all** — it could only be stretched or tiled, and both put pictures under moments
  they do not belong to, which is worse than a blank clip: the strip is what an
  editor reads to find the frame to cut on.

  `ClipStrip` states the placement in *clip widths* rather than pixels or seconds,
  because the pixel width changes with every zoom and the placement does not. It
  renders as an `<img>` inside a clipping box rather than a background image, since
  CSS background percentages resolve against the difference between image and box —
  percentage `width`/`left` on a child resolve against the box, which is exactly the
  arithmetic the model describes. Verified live: splitting a clip at its midpoint
  gives two halves at `width: 200%`, `left: 0%` and `left: -100%`.

  Waveforms take the other path, because peaks are resolution-independent — one
  derivation serves every zoom — so the picture is drawn in the renderer at the size
  the clip is shown. Two rules there came from looking at the result rather than the
  code: silence draws a **centre line**, not nothing, because nothing is
  indistinguishable from "not derived yet"; and the drawing is normalised against
  the **whole file** (capped at 12×), because material mastered at −20 dBFS drew a
  two-pixel line that read as silence, while normalising per visible range would
  make the same clip change loudness as it was trimmed.

- 2026-08-08: In/out marks and markers. The same shape of gap as the strips, one
  layer deeper: `workRange` was load-bearing everywhere — it bounds playback, it
  is the default export range, `snap.ts` offers both its edges as candidates, the
  serializer round-trips it — and **nothing could set it**. Spec 6.1 asks for in/out
  markers; the model had been ready for them since Phase 1.

  The design question was not how to store a range but what a mark means when it
  contradicts the other one. The rule: **a mark is never refused**. Pressing in past
  the out point is how an editor moves a range forward, not a mistake, so the far
  mark yields and the action reports that it did. Refusing would make the user clear
  the range before re-marking it, every time — technically correct and unusable.
  Marking in with no range yet runs to the end of the sequence rather than one frame,
  because "render from here on" is nearly always what it means. The out point
  includes its own frame: half-open spans are an internal convention, and the
  conversion belongs at this boundary rather than in every caller.

  The keys are the feature, not a convenience — `I`, `O`, `M`, `Alt+X`, `Alt+←/→` —
  and the toolbar buttons stay because a shortcut nobody knows about does not exist.
  Every handler reads the document through a ref: they are attached once to the
  window, and a closure over the mounting document would silently discard every edit
  made since. That is what one of the tests is for.

  Wiring it found a real inconsistency. `defaultRange` in the export hook re-derived
  "the whole sequence" by hand and ignored `workRange`, while the export *planner*
  honoured it — so marking an in point would have made the dialog and the encoder
  disagree about what was being rendered. It now delegates to `renderRange`, which
  exists precisely so playback and export share one definition.

  Verified in the running app through the keyboard alone: `I` at 21 and `O` at 51
  produced a 21–51 readout and a bar 21 px in and 31 px wide at 1 f/px, `M` left a
  flag at 51, playback stopped at the out point, plain `X` did nothing and `Alt+X`
  cleared the range. No page errors.

- 2026-08-08: Autosave and crash recovery — spec §8, and the third unwired
  subsystem in a row. `@nos/core/patch/autosave.ts` had the whole policy with its
  own tests: write only when dirty and no gesture is open, never touch
  `project.json`, offer a recovery file only when it is newer than the saved
  project. Nothing in the application had ever called it. **A 30 s autosave that
  never runs is indistinguishable from no autosave**, and losing an afternoon's
  work is the one failure an editor cannot apologise its way out of.

  What could not live in `@nos/core` — it must stay free of I/O so it runs in a
  worker — is the persistence seam, so that is what was added: three narrow
  channels on the trust boundary (`saveRecovery`, `loadRecovery`, `clearRecovery`)
  and a hook implementing `DocumentPersistence` over them.

  Two decisions are load-bearing. The recovery write is **atomic** for a sharper
  reason than `project.json`'s: a recovery file exists precisely because the process
  may die at any moment, and one that dies mid-write leaves a torn file the next
  launch would offer as the user's unsaved work — worse than none. And
  `loadRecovery` returns **both timestamps in one call**, because the decision they
  feed is only sound if they describe the same moment; two round trips could
  straddle a save and offer work older than what is already on disk.

  The offer is a banner, not a modal, and nothing is preselected: "is this newer
  than what I have?" cannot be answered from a dialog covering the answer. A
  recovery file that cannot be parsed is neither offered nor deleted — deleting it
  would destroy the only copy of work the user might still salvage by hand.
  Accepting *resets* the store rather than committing, because stacking recovered
  work on the history of a document the user never saw makes undo nonsense.

  Verified against a real crash: edited without saving, let the autosave land,
  killed the process with `SIGKILL`, relaunched. The banner offered the work with
  its timestamp, "Restore it" brought the in/out range back, and an explicit save
  removed the recovery file so the next launch offers nothing. No page errors.

- 2026-08-08: The project folder is watched for real. The browser had been
  reporting **"watching"** whenever the initial scan succeeded — over a folder
  nothing was watching. A generator writing into `generated/`, a file dropped in
  from a file manager, an external tool rewriting a note: none of it appeared until
  the project was reopened. The spec's model that a project *is* a folder only
  holds if the application notices what happens to that folder, and `@nos/media`
  had the whole vocabulary — ignore rules, burst coalescing, `applyChanges` — with
  nothing calling it.

  The watcher lives in the main process; what crosses the boundary is a batch of
  project-relative changes, never a raw path. That needed a new *direction* on the
  trust boundary, so push channels are declared separately from `IPC` and the
  preload wraps each one as its own named subscription — exposing `ipcRenderer.on`
  would be the same mistake as a generic `invoke`, one channel-name bug from the
  whole main-process surface.

  Three things only the running application could have found, each measured rather
  than guessed:

  - **Status was reported by nobody.** The watcher starts while the project is
    still opening, before any renderer knows there is a project to subscribe for,
    so its first push went nowhere and the browser said "idle" forever. The state
    is now held and asked for on subscribe.
  - **Files written into a folder created moments earlier arrived with no event.**
    The recursive watcher registers interest in a new subdirectory only once it has
    seen it — which is precisely what a generator does: create an output folder,
    immediately fill it. A newly added directory is now expanded into its contents.
  - **Deleting a folder left its files in the tree.** `applyChanges` pruned
    descendants only when the change said `isDirectory`, and a watcher *cannot*
    know that: the only way to tell is to ask the filesystem, and by then the path
    is gone. It now prunes on any removal, which is safe because nothing lives
    under `media/a.mp4/`. The contract now says `isDirectory` is meaningless for a
    removal, rather than leaving the next caller to rediscover it.

  Two of my own probe runs reported failures that were the probe's fault — a folder
  row reads `run-912`, name and count, not `run-9`. Worth recording because the
  temptation each time was to "fix" working code.

  `project.recovery.json` is now hidden from the browser on both sides of the
  shared vocabulary: it appears and disappears on its own schedule, so showing it
  made the tree flicker a file in and out while the user worked.

- 2026-08-08: Level and pan for audio clips. The document has carried `gain` and
  `pan` as animatable parameters since the model was written, the mix graph samples
  both, equal-power panning is implemented and the export honours it — and nothing
  could **set** either. Selecting an audio clip gave an empty inspector: the effect
  stack applies to video and images, so every audio decision was unreachable from
  the application.

  Gain is stored linear and shown in **decibels**, because that is the unit the
  work is done in — "6 dB down" is something an editor means, "0.5 gain" is not.
  The conversion lives at this one boundary; the mix plan, the export and the
  meters all keep reading the linear value.

  Three rules the control needed to be usable rather than merely present. The
  slider bottoms out at the mix graph's own floor, where gain is *defined* to be
  zero, so it can mute a clip rather than approach silence. Unity and centre have
  explicit buttons, because returning a fader to exactly 0.0 dB by hand is a coin
  flip and being half a decibel off is inaudible until it is summed with everything
  else. And pan has a detent at centre, with a readout that says `L35` rather than
  `−0.35` — the first tells the user what they will hear.

  Animating is an explicit act, matching how effect parameters already behave, and
  un-animating keeps the value **at the playhead**: the number on screen when the
  button is pressed is the one the user means to keep. The keyframe lanes gained
  `audio · gain` and `audio · pan`, without which a fade could be switched on and
  never shaped — an audio clip has no transform to hide those channels in and its
  gain is not an effect parameter.

  Verified in the running app: selecting the linked audio clip shows both controls,
  driving them writes −12.0 dB and L60, pressing animate produces an
  `audio · gain` lane, and double-clicking the lane lands a marker.

- 2026-08-08: Editing proxies. Spec 6.2 asks for realtime 1080p/30 preview **from
  proxy**, and the sidecar has been able to make them since M2 — `/media/derive`
  transcodes to a constrained short edge and caches by content hash, verified
  against real ffmpeg for landscape and portrait alike. Nothing ever asked it to.
  `DEFAULT_PROXY` had no callers, so a 4K source was decoded at 4K to fill a canvas
  a thousand pixels wide.

  The substitution is a **function** handed to the decoder, not a lookup inside it.
  That is what keeps the WYSIWYG guarantee reviewable: the preview passes a
  resolver, the export passes nothing, and the one place the two could diverge is a
  single parameter with a test asserting the export has no way to reach a proxy.
  A future mode — full resolution for the selected clip, a coarser proxy while
  scrubbing — is another implementation of that one-line contract rather than a new
  branch in the decoder.

  Three rules, each of which would be a defect the other way round:

  - **The original is decoded until its proxy exists.** A transcode takes as long
    as it takes; a preview that went blank while it ran would trade a slow picture
    for no picture.
  - **A source is proxied only when the proxy would be smaller.** Re-encoding 720p
    to a 1080p proxy costs a full transcode, loses a generation, and hands the
    decoder the same pixels. Judged on the *short* edge, so portrait material is
    not transcoded for nothing.
  - **Frame rate is deliberately not a reason to proxy.** Dropping 60 fps to 30
    changes which frame lands on a timeline frame, and a preview showing different
    frames from the export would break the guarantee proxies exist to protect.

  Transcodes run **one at a time**: it is the heaviest thing this application asks
  of the machine, and ten in parallel for a ten-clip timeline would starve the
  preview they serve while finishing no sooner. Wiring it also found a leak worth
  keeping: the decoder cached elements by asset, so a proxy arriving mid-session
  would have left the original's `<video>` open and buffering for the rest of the
  session. It is released when the URL under an asset changes.

  Verified against a real 3840×2160 source: the notice read "building an editing
  proxy for media/uhd.mp4", the request log shows `media/uhd.mp4` fetched first and
  `cache/proxy_1080p30q23_….mp4` fetched once it landed, and the cached proxy
  probes as 1920×1080 at 30/1.

- 2026-08-08: The media browser says what a file is, and what the cache costs.
  Selecting a file in the browser had never done anything: `onSelect` was unwired,
  the `detail` slot was never filled, and `AssetDetail` and `summarizeMetadata`
  had both sat unused since M2. A user could not tell a 4K source from a
  proxy-sized one, or find out whether a clip would play back smoothly — the
  question the pane exists to answer.

  Derived artifacts are detected by **looking**, never by asking. `/media/derive`
  would produce the missing one, turning "is there a proxy?" into a minutes-long
  transcode nobody requested, so presence is read off a listing of `cache/`. The
  match is on kind and content hash rather than on an exact filename, because the
  spec in between varies — the filmstrip's thumbnail rate follows the zoom level,
  so an exact-name check reports "no filmstrip" for an asset that has three.

  A source too small to need a proxy shows **no proxy line at all** rather than a
  pending one. There is no proxy question for a 720p file, and a "…" that never
  resolved would read as work stuck rather than work not needed.

  The cache half answers the spec's own sentence — show `cache/` with its size *so
  the user can judge whether to clear it* — which had a size and no way to act on
  it. Proxies made it urgent: one 4K source now leaves a large transcode behind.
  Clearing is safe by construction rather than by care, and the response reports
  what is *left* rather than what was removed, so a file the sidecar could not
  delete stays counted.

  One bug found by looking rather than by reasoning: the first implementation read
  the cache listing off the browser's tree, which deliberately hides cache
  *contents* — so the listing was always empty and both indicators could never be
  true. The tree showed the folder; the folder had no children to inspect.

  Verified in the running app: a 320×180 source reads `320×180 · h264 · 0:03` with
  `filmstrip ✓` and no proxy line; a 3840×2160 source reads `proxy ✓ filmstrip ✓`;
  and Clear took the cache from 5 files to 0 on disk with the footer following.

- 2026-08-08: Tracks can be added, removed and toggled. The spec's timeline is
  **N video, N audio, N text**; a project had exactly one of each for its whole
  life, because the mockups' `+ Track` button was wired to nothing. A title over a
  title, or music under dialogue, was simply not expressible. The M/S/L buttons on
  every track header were dead too — mute and solo drive both the composite and the
  mix through `isTrackAudible`, so the plan builders honoured a state nothing could
  reach.

  A new track lands **after the last track of its own kind**, not at the end. The
  timeline reads video, then audio, then text; a second video track appearing below
  the audio would break that reading for every project it happened in, and no
  amount of naming would recover it.

  Removal takes the track's clips with it, because undo is the safety net and
  requiring a track to be emptied first would mean deleting fifty clips by hand to
  get rid of one row — but the shell says how many went, since a user who did not
  realise what was on a collapsed row should not have to discover it by undoing. A
  **locked** track is refused: locking exists to say "do not disturb this", and
  honouring it for stray drags but not for removal would make it worthless. Muting
  and soloing a locked track stay allowed — locking protects content, not
  monitoring.

  Two defects this surfaced, both from the assumption that the track list could not
  change:

  - **Nudging moved clips to the wrong track.** It passed a hard-coded first video
    track, so nudging an audio clip was rejected for the wrong kind and nudging
    anything on a second video track would have silently moved it up one. It now
    keeps the clip on its own track.
  - **Import targeted hard-coded ids.** Safe only while `V1` was guaranteed to
    exist; the first thing the new remove button can do is make it not. Resolved
    from the document by kind now.

  A third came from watching the ids: the generator produced `v1` for a project
  whose first track was `V1` — two ids differing only in case, indistinguishable in
  every log line a user reads and one careless comparison from being the same
  track. Uniqueness is checked case-insensitively.

  Verified in the running app: adding one of each kind lands them in the right
  places, removing `V1` leaves the import to find `v2`, a locked track's remove
  button is disabled with its reason, mute still works on it, and undo walks back
  through all of it.

- 2026-08-08: The output meter. The engine has computed peaks with proper decay
  since M3 and `usePlaybackAudio` exposed them; nothing displayed them, so the only
  way to know whether a project clipped was to export it and listen. That gap got
  worse the moment level and pan controls landed — a fader with no meter is a
  guess.

  Wiring it exposed a real defect rather than only a missing view. `meters` was
  computed as `engine.readMeters()` **during render**, and that call is not a
  query: it pushes the analyser's latest block into the peak meter and advances its
  decay. The reading therefore depended on how often React happened to re-render,
  and a strict-mode double render would have pushed every block twice. It is polled
  on an animation frame now, which is the only cadence that means anything for a
  meter.

  The scale is logarithmic because a meter is read against decibel marks: a linear
  bar spends nine tenths of its travel in the top 20 dB, where the difference
  between "present" and "inaudible" would be invisible. Zones change at −6 dBFS —
  the conventional headroom mark — and again at full scale.

  Two rules that follow from what a meter is for. The bar carries **no transition**:
  the decay that makes a peak readable is the engine's, applied to the value, and
  animating on top of it would draw a level that was never measured. And the clip
  indicator **latches** until acknowledged, because a clip that happened while the
  editor looked away is exactly the one worth knowing about — clearing it goes
  through the engine, or the next poll would re-report the clip the user just
  dismissed.

  Polling continues briefly after playback stops so the meter *falls* at its own
  rate rather than snapping to zero and hiding the last peak.

  Verified in the running app: silent at rest, −20.8 dBFS during playback of the
  test tone — which matches the −20.9 dB its measured amplitude implies — and back
  to silent within a second of stopping. One earlier reading that looked like a
  stuck meter was the probe restarting playback at the end of a three-second clip.

- 2026-08-08: A clip can be opened. Spec §6.1 is specific — *a klip kinyitható:
  alatta megjelennek az effekt paraméter-sávok keyframe jelölőkkel* — and the lanes
  existed, worked, and were drawn **at the foot of the whole panel**, three tracks
  away from the clip they described. A lane is read against its own clip; one drawn
  somewhere else has to be correlated by eye, which is most of the value gone.

  The lanes now render inside the timeline, directly beneath the track holding the
  opened clip. `Timeline` takes the clip id and the lane content as a slot, so it
  stays presentational and still knows nothing about keyframes — the same
  arrangement the media browser's detail pane uses.

  The disclosure appears **only on a clip that has something to show**. That needed
  a single honest predicate rather than a UI-side guess, so `hasAnimation` joins the
  document model: transform channels, a text clip's reveal, an audio clip's level
  and pan, and any effect parameter — every place a keyframe can live, in one
  place. An empty disclosure is a control that punishes the user for using it.

  Two details that only matter once it is in the hand. The disclosure stops its own
  pointer-down, because it sits on a clip body whose pointer-down *begins a move
  gesture* — without that, opening a clip would nudge it. And one clip is open at a
  time: several would push the tracks below off screen, and the lanes of two clips
  on different tracks cannot be compared anyway.

  Verified in the running app by measurement rather than by eye: with nothing
  animated there is no disclosure at all; animating the audio clip's gain makes one
  appear on that clip only; opening it puts the lane container at y=864, between
  the audio track at 804 and the text track at 917 — under its own track, as the
  spec asks — and closing removes it.

- 2026-08-08: Clips can be removed. The plainest gap in the application: it could
  put clips on a timeline and never take one off. `liftClip`, `rippleDeleteClip`,
  `setClipEnabled` and `splitAllTracksAt` have all existed in `@nos/editing` since
  M3, tested, with no way to invoke any of them — and the toolbar's **Ripple**
  toggle was the same story from the other end, a control whose state nothing read.

  That toggle is what decides between the two removals, which is the only
  interesting decision here. **Lift** leaves the gap, so everything downstream keeps
  its timing; **ripple** closes it, pulling the rest of that track back. Neither is
  a safe default for the other's situation, which is why the choice is a visible,
  persistent mode rather than a guess — and why holding shift gives the *other* one
  **without changing the mode**: an editor reaches for it once, for one clip, and
  does not want the toolbar to have silently flipped afterwards. The button is
  named for what it will do — `Delete` or `Ripple delete` — rather than leaving the
  user to remember which mode is on.

  A multi-clip removal is one history entry, because removing three clips is one
  decision. A refusal — a locked track among the selection — leaves that clip both
  present *and still selected*, since it is still the thing the user was acting on;
  the others go, rather than the whole action rolling back work that was wanted.

  `E` reaches `enabled`, which the clip body has drawn at 40% opacity since M3 with
  nothing able to set it. `Shift+S` cuts every unlocked track at once, which is the
  point of a cut-all: a razor through one track alone desynchronizes what was
  deliberately aligned.

  Verified in the running app by position: `S` split the clip into halves at x=448
  and x=478; `E` took the first to 0.4 opacity; `Delete` with ripple **off** left
  the second half at 478; with ripple **on** it moved back to 448. The gap closing
  is the whole difference, and it is now visible in the pixels.

- 2026-08-08: Slip, and cutting the marked range. The last two editing operations
  the spec names that had no way to be invoked. §6.1 lists *csúsztatás* among the
  timeline's verbs, and `slipClip` had been sitting in `@nos/editing` since M3;
  `rippleDeleteRange` had been waiting for in/out marks, which arrived earlier
  today and then went unused by it.

  Slip is **alt-drag on the clip body**, not a mode. It is the one edit whose result
  the clip's outline cannot show — nothing moves — so a user who triggered it by
  accident would see the picture change with no visible reason. Dragging left pulls
  later material into the window, because the content should follow the pointer
  rather than the source read position.

  The range cut applies to **every unlocked track**, not the selected one: a range
  is a span of the *programme*, and taking a section out of the picture while
  leaving it in the sound is not something anyone marks a range to do. It clears
  the marks afterwards — the section they described no longer exists, and leaving
  them would invite the user to remove the material that has just moved into its
  place.

  Verified in the running app by geometry, which is the only way slip *can* be
  verified: after alt-dragging, the clip stayed at x=468 with its width unchanged
  at 70 px while its filmstrip offset moved from −28.6% to −45.7% — the content
  sliding inside a window that did not move. The filmstrip placement work from this
  morning is what makes that visible at all. The range cut then left the surviving
  tails of both the video and its audio at x=488 with the range bar cleared.

- 2026-08-08: The view follows the work, and undo has a key. `scrollFrame` changed
  only as a side effect of zooming, so the timeline never moved on its own: during
  playback the playhead left the right edge and the view sat still, showing
  material that was no longer playing. There was no way to scroll at all, and
  `zoomToFit` had been written and tested with nothing calling it. Undo and redo
  had buttons in the inspector and no keyboard — `Ctrl+Z` did nothing.

  The view follows **only while playing**. A user scrubbing or dragging is looking
  at something they chose; yanking the view back would fight them.

  This surfaced a bug that had been throwing since the shell was built: the
  anchored zoom computed `scrollFrame + anchorPx * (before − after)` and handed the
  result to `frameIndex`, which refuses a non-integer. Almost every zoom step lands
  on a fraction, so **every ctrl+wheel zoom threw** — unnoticed, because nothing was
  watching the renderer's console. Rounding fixes it and a test now covers a whole
  gesture of steps.

- 2026-08-08: Copy, cut, paste and duplicate. Not named in the spec and not
  optional either — an editor without it makes a user rebuild a three-clip lower
  third by hand every time they want a second one. It is the one editing capability
  this project had never *modelled*; everything else existed and merely needed
  reaching.

  The design turns on what a copied clip remembers: **not its absolute position**,
  which is the one thing the user is about to change, but its offset from the
  earliest clip in the copy. That is what makes a multi-clip paste preserve the
  shape of what was copied — a title and its music cue land the same distance apart
  wherever they are put down.

  A paste is **all or nothing**. Dropping the clips that fit and skipping the rest
  would leave a half-pasted lower third, and the user cannot see which half is
  missing without inspecting a clipboard they have no way to inspect. The check
  runs against the placements already made as well as against the document, or two
  clips of one paste could each be reported as fitting and then land on each other.

  A collision is not reported, though: it is turned into the result the user wanted.
  They asked to put something down, and "there is already a clip there" is a fact
  they can see — where the next gap is, is the part worth doing for them. Duplicate
  is that same move with the destination chosen as *immediately after the original*.

- 2026-08-08: Tracks can be renamed. `A2 · music` is the form the model has always
  documented and the header could only ever show `A2`, because nothing could write
  a name. `setClipLabel` had the same shape of gap and gained the same guard.

  Double-click rather than a pencil button: the header is already dense with M/S/L
  and a remove control, and renaming is rare enough that it does not deserve
  permanent width. Enter commits, Escape abandons — a field that could only be left
  by clicking elsewhere leaves the user unsure whether their change took.

  A **blank** name is refused rather than stored. A row with nothing in it cannot be
  referred to at all, which is the one thing a name is for. A **locked** track can
  still be renamed: locking protects what is *on* a track, and the label is not on
  it — refusing would make locking a finished layer cost the ability to say what it
  holds.

- 2026-08-08: Marquee selection, select-all and linked clips. Selection had been
  one clip at a time, or several by shift-clicking each — which made every
  multi-clip operation now in the application (copy, delete, disable) technically
  reachable and practically not. Nobody shift-clicks eleven clips to move a scene.

  The rule that matters is **intersection, not containment**. A marquee is reached
  for precisely when there is too much on screen to click, and at that zoom the clip
  a user wants usually runs off both edges of their rectangle; requiring it to be
  wholly inside would make selecting a long clip impossible exactly when it matters.

  The rectangle is drawn in pixels because that is what the user drags, and reported
  as **frames and track ids** because which clips it touches is a question about the
  document. `SelectionRegion` therefore lives in `@nos/core` rather than in the
  editing package, so the presentational timeline can report one without depending
  on the operations that consume it.

  A drag shorter than a few pixels is a click, not a selection: reporting it would
  clear the selection every time a user tapped the background. Adding is *union*,
  never toggle — a second marquee over something already selected should not quietly
  remove it.

  One robustness fix came out of the tests rather than the design: the gesture began
  with `event.button !== 0`, which rejects a synthetic pointer event that carries no
  button at all. A missing button is not a right-click, and it is now read as
  "primary unless stated otherwise".

- 2026-08-08: Material can be dragged onto the timeline. The browser's rows had
  been `draggable` since M2 and reported `onDragStart` to a shell that did nothing
  with it; the timeline was not a drop target at all, so the only way to place
  anything was to double-click and take whatever position the playhead happened to
  be at. Dragging exists precisely to say *where*.

  The asset travels on the drag itself, under a custom MIME type, rather than in
  application state — a drop then knows what it received without the two sides
  agreeing on a variable a cancelled drag would leave stale, and a fragment of text
  dragged in from another application is refused rather than imported as nothing.

  A drop onto a track that cannot hold the material is **not** refused. The
  gesture said *where*, and the kind of the media decides *which row*; answering
  "wrong track" for a video dropped on an audio row would be technically true and
  unhelpful, so it falls back to the default track of its own kind.

  jsdom has no `DragEvent`, so a drop cannot be dispatched at a React handler
  there. Rather than assert on a gesture the environment cannot express, the
  decision — which track and which frame — is a pure exported function with its own
  tests, and what remains in the component is reading the payload and calling it.
  The same split now covers the marquee's geometry.

- 2026-08-08: The snap indicator. Snapping has worked since M3 and
  `snapSpanTranslation` has always reported **what** it caught — the drag hook
  threw that away. Without it, a clip locking to a cut is indistinguishable from a
  clip refusing to follow the pointer, and a user who cannot see what it caught
  learns to distrust the feature and turns it off.

  The line is **named** as well as drawn: "playhead" and "the end of that clip" are
  different reasons for a clip to have jumped, and a bare line leaves the user to
  work it out. Dashed, so it is never mistaken for the playhead it may be sitting
  exactly on top of.

- 2026-08-08: Operations reach the whole selection, and linked clips travel with
  their partner. Dragging one clip of a selection had moved only that clip, which
  quietly undoes the point of having a selection: a user who marqueed a scene and
  dragged it would find one clip moved and the rest left behind — the worst outcome
  available, because it looks like it worked. `withLinkedClips`, written yesterday
  for the marquee, had no callers.

  `moveClips` is deliberately **not** a loop over `moveClip`. Applied one at a time,
  each move collides with the clips that have not moved yet, so shifting a run of
  adjacent clips would refuse at the first one because its neighbour is still where
  it was. The set has to be shifted and *then* checked, which is the entire reason
  the operation exists.

  Its collision rule is exact rather than convenient: only pairs with **exactly one**
  side moving are checked. A translation preserves relative positions, so two clips
  both in the set overlap afterwards if and only if they overlapped before —
  reporting them would blame this move for a state the document was already in, and
  leave a selection unable to escape a mess it did not create. A test covers that
  case; it is the one that caught the rule.

  The group meets frame zero **together**: clamping each clip on its own would pile
  a whole scene onto the first frame. Delete, copy, cut and duplicate now take
  linked partners along too — deleting the picture and leaving its sound playing
  over the next shot is never what was meant.

- 2026-08-08: The project's rate and resolution can be changed. Both have been in
  the document since M1 and neither could be changed after a project was created —
  a decision most editors make *after* seeing their material, not before.

  Resolution is the easy half, and stays easy because transforms are normalized to
  `[0, 1]` of the output: a resolution change moves nothing.

  Rate is the difficult half. Every time in the document — clip spans, keyframe
  positions, markers, the in/out range — is a **frame index at the project rate**,
  so changing the rate without rebasing them would silently retime the whole
  programme: a cut two seconds in at 24 fps would land at 1.6 seconds at 30. All of
  it is rebased through the time layer's exact conversion, with durations rounding
  **up** and positions to nearest — the pairing that keeps a clip from losing its
  tail. The one thing deliberately left alone is a clip's *source* rate: it
  describes the file rather than the timeline, and rebasing it would make every
  frame read from the wrong place.

  The change is armed rather than applied, and says what it will cost first. It is
  irreversible in a way undo does not fix — converting 30 → 24 and back does not
  return the original positions — so it gets the only confirmation step in this
  application.

  The cost is measured on the **exact rational**, not by converting and back. Frame
  1 at 30 fps becomes 0.8 of a frame at 24, which rounds to 1 and converts back to
  1: a round trip that looks lossless while the position has in fact moved. The
  first implementation did exactly that and reported nothing was lost; a test that
  expected a loss is what caught it.

- 2026-08-08: The timeline scrolls vertically, and tracks can be resized. A defect
  the `+ V/A/T` buttons created two days ago and nothing had caught: the track area
  was a fixed height with `overflow: hidden`, so the moment a project had more
  tracks than fitted, the rest were **invisible and unreachable** — no scroll, no
  way back to them. The ruler is now pinned and the tracks scroll under it.

  Headers and lanes scroll as **one element**, which is the only arrangement that
  keeps them aligned: two scrollers kept in sync by hand drift the moment either is
  scrolled by anything other than a wheel.

  Track height was persisted in the document from M1 and could not be changed. The
  grip is on the header's bottom edge rather than on the lane, because the lane is
  covered in clips whose own drags mean something else entirely, and it reports
  live rather than on release — a row that only resized when the pointer came up
  would be adjusted by trial and error. Bounded at both ends: a floor that keeps a
  row tall enough for its own controls, and a ceiling that stops one track filling
  the window and hiding every other, which is what a free-form drag produces within
  seconds of being discovered.

  A whole drag is one undo step, through the store's gesture, and the end is
  reported **before** the pointer capture is released. A gesture that ended without
  saying so would leave the undo entry open for the rest of the session and swallow
  every later edit into it — which is exactly what happened in the test environment,
  where `releasePointerCapture` does not exist and threw first.

- 2026-08-08: A clip's look can be copied onto others. The gap was not that an
  effect could not be added — it could — but that adding one to eleven clips meant
  repeating the same eleven-step ritual and getting the parameters subtly different
  each time. Grading a scene is the ordinary case, and doing it clip by clip is how
  a grade drifts.

  The boundary is the whole design: everything describing **how a clip looks or
  sounds** travels — effects with their keyframes, transform, speed, level and pan —
  and nothing describing **which material it is or where it sits**. Source, span,
  label, provenance and links all stay. A paste that moved a clip or swapped its
  media would be indistinguishable from a bug, so most of the tests are about what
  must *not* change.

  Two rules follow from what a user meant by the gesture. A transform pasted onto an
  audio clip is **dropped, not refused**: someone who selected a scene and pasted a
  look meant it to land wherever it makes sense, not to be told that one of the
  eleven clips was audio. And a locked target is refused while the rest still
  receive it — one protected clip must not block an edit to ten unprotected ones,
  and the refusal is only *reported* when nothing landed at all.

  Effect instance ids are regenerated per target, and required rather than
  generated internally: two clips sharing an instance id would make the inspector's
  selection ambiguous and every later edit land on whichever clip was found first.
  Derived from the target and the stack position, so pasting the same look twice
  produces the same document.

  The look has its **own** clipboard, reached by the shifted chords — copying a
  grade must not lose the clips a user copied a moment earlier.

- 2026-08-08: A finished export can be revealed. `revealInFolder` has been on the
  bridge since the shell was built and had no callers; the dialog said "complete"
  and stopped there, leaving the user to go looking for a folder they never chose.
  After a render that took minutes, "show me the file" is the next thing anyone
  wants.

  The first version printed the output path beside the button and a test caught it
  as a duplicate — the destination is already named in the field above. The control
  now carries the path in its own title and adds the *action* rather than a second
  copy of the information.

- 2026-08-08: **Issue #3** — generated output was unreachable. The report: three
  SFX variants generated, visible in ComfyUI, visible in the Variants tab, and
  neither audible nor present in the file browser.

  The cause was one missing step. `collect` built `generated/<filename>` — a
  *project-relative path* — and **nothing ever downloaded the file**. ComfyUI writes
  into its own output directory, so a job could finish, report three files and show
  three variants while none of them existed anywhere the application could read.
  The module's own header had documented `GET /view?filename=… download` since M10;
  the download was never written.

  Fetching now happens in the main process, through a new `backendDownload` channel:
  bytes crossing the boundary and a path on disk are both its business and neither
  is the renderer's. Written to a temporary sibling and renamed, because the folder
  watcher is live and a partially written file would surface in the browser as an
  asset the user could drag onto a timeline.

  Outputs are prefixed with the job id. ComfyUI names by prefix and counter, so two
  runs of one generator both produce `bed_0031.flac` and the second would overwrite
  the first.

  The second half of the report — *"nor can I listen to them"* — was a control the
  picker has offered since M9 with nothing wired to it. Auditioning is an element
  rather than the mix engine on purpose: what is being auditioned is one *file*,
  before it is a clip, with no track, no automation and no place on the timeline,
  and routing it through the mixer would mean inventing all three to throw them
  away. Selecting a different variant stops the previous one, which is the one
  thing that would otherwise make an A/B comparison useless.

- 2026-08-08: **Issues #4 and #5** — the link, and the right-click menu.

  #4 asked for three things and had one: linked clips already moved together after
  this morning's work. What was missing was *seeing* the link and *breaking* it.
  A chain badge on the clip closes the first — a user whose sound follows their
  picture without knowing why cannot tell a feature from a fault. Unlinking closes
  the second, and it breaks **both sides, always**: a one-sided link is worse than
  none, because every operation that follows one would behave differently depending
  on which half the user grabbed. Linking is refused when either clip already
  belongs to a pair, rather than stealing a partner and leaving exactly that state.

  #5 reported that `Ctrl+Z`, `Ctrl+Y` and `Del` did nothing and there was no
  right-click menu. The keys were wired earlier the same day, after the issue was
  filed; the menu was genuinely missing, and it is the more interesting half. Every
  action it offers already exists on a button or behind a shortcut — a context menu
  is not new capability but the **discoverable** path to what a user can already do.

  Three decisions in it are worth stating. The menu keeps the **same rows whatever
  the state**, disabling rather than hiding, so it does not change shape under the
  pointer between right-clicks. Every row **names its shortcut**, so the menu
  teaches the keyboard instead of competing with it. And right-clicking an
  unselected clip **selects it first** — acting on something other than what was
  clicked is the one behaviour a context menu must never have.

  What the menu *offers* is a value, computed from the document, the selection and
  the clipboard, and tested without rendering anything; the component itself only
  knows how to be dismissed, chosen from, and kept on screen.

- 2026-08-08: **Issues #1, #2, #6 and #7** — the visual pass, taken as one change
  because they are one problem seen from four sides.

  #6 said everything blended together, and it was right for a measurable reason:
  the app, panel and canvas backgrounds sat within six units of each other, and the
  borders were barely a shade off the surfaces they divided. The structural
  surfaces now step apart deliberately and the borders are lines rather than
  suggestions. That is a token change, which is exactly the right lever — one edit,
  every panel.

  #7 asked for a light theme. The tokens' own header had argued for dark-only, and
  the argument was sound: a bright surround changes what a graded frame looks like.
  It is not a reason to withhold the choice, so dark is now the *default* rather
  than the only option. Only colours are redeclared — every metric, font and timing
  is shared, because a theme is a change of surround and not of layout. The accents
  keep their meanings and change their values: the blue that reads as an accent on
  near-black is illegible on near-white.

  Two decisions inside it. The **preview canvas stays dark in both themes** — it is
  the one surface that is not chrome, and a white surround around a graded frame is
  the thing the dark default exists to prevent. And the start-up theme deliberately
  **does not follow the system**: a first run on a light desktop would put the user
  in the wrong environment for the one judgement this tool supports. The verification
  run caught that — the app came up light, because the original implementation
  consulted `prefers-color-scheme` two lines below a comment explaining why it
  should not.

  #1 asked for real icons. A coloured square said there were four kinds of thing
  without saying which was which, and nothing in the window taught the palette. Each
  glyph is now the thing the file *is* — a frame with sprocket holes, a waveform, a
  picture, lines of text — drawn as inline SVG so it inherits `currentColor`, needs
  no network, and adds nothing to a project folder that belongs to the user. The
  colour stays as reinforcement, which also makes the browser readable to someone
  who cannot separate the hues.

  #2 moved the transport under the preview. In the title bar it sat among file and
  project actions, a hand's width from the frame being scrubbed and beside buttons
  with nothing to do with playback.

- 2026-08-08: **Issues #8 and #9** — the variant picker, and a length control that
  did nothing. Both had the same shape: the *batched* run, which is how the spec's
  own audio manifest generates, and which nothing downstream distinguished from a
  set of separate runs.

  A batched run is **one submit carrying several seeds**, so three variants share a
  single run id. Everything keyed on that id therefore collapsed: `buildSelection`
  resolved a selection by run, so picking the second variant always returned the
  first; the picker keyed its chips by run, so three chips shared one React key and
  **all highlighted together**; and accepting derived the clip id from the run, so
  the second variant collided with the first and was refused. Every symptom in the
  report — selection invisible, no way to tell which is playing, Keep doing nothing
  — is that one missing distinction.

  Candidates now carry their own `key`, derived from the run and the output index so
  it survives the rebuild every progress tick causes. The outcome carries it too,
  because a caller deriving an id from the run alone would reproduce the collision.

  **Discard** was a second, unrelated fault: it called `cancelGroup`, and a group
  that has *finished* has nothing to cancel — so the group stayed in the snapshot,
  the picker kept showing it, and the button appeared dead. Dismissing is now its
  own operation: cancel whatever is still running, then forget the group. The files
  stay on disk, which is the spec's rule that nothing is destroyed.

  #9 was the same class of silence. The accepted clip's length came from
  `placeholderLength({ params: {} })` — an empty parameter set, which falls back to
  the manifest's default. A user who asked for ten seconds got fifty and nothing on
  screen explained it. The group's parameters now travel with the outcome. The
  number fields showed `0` for an untouched parameter for the same reason, telling
  the user a generator would run with zero when it would in fact run with fifty.

- 2026-08-08: Issues #10, #11 and #14.

  **#10** was mine. Moving the ruler into a row of its own — so it would stay put
  while the tracks scrolled — gave it a width of its own. The moment a project had
  enough tracks to raise a scrollbar, the lane column gave up fifteen pixels and the
  ruler did not, so every tick pointed fifteen pixels away from the frame it named
  and the error grew with the zoom. That reads exactly as the report described it:
  the tracks slipped sideways. The ruler is sticky inside the lane column now. It
  still stays put, and there is one width instead of two, so there is nothing left
  to keep in sync. Measured live at eight tracks: ruler and lanes both 1117 px at
  the same left edge, where before only the lanes shrank.

  **#11** was a feature that had never been reachable. A manifest may declare a
  parameter that names a file — `first_frame`, a voice reference, a mask — and the
  panel rendered every one of them as a read-only field reading `not set`. Every
  image-to-anything generator was therefore a dead end, and `Generate` stayed lit
  and submitted a graph with an empty image slot, so the failure surfaced in ComfyUI
  where its cause was much harder to see.

  The picker offers the project's own files, filtered by the parameter's *declared
  type* and never by the generator, which is the property the framework rests on.
  Cache contents are excluded: they are regenerated under hash-derived names and
  deleted on Clear, so a run pinned to one would stop reproducing. A run now reports
  everything blocking it at once, as values, so the greyed button and the field it
  names cannot disagree.

  **#14** followed immediately: pick a first frame that is not a file yet. The frame
  under the playhead is very often the one meant — the end of the previous shot, a
  pose mid-take — and exporting a still by hand, finding it, and coming back is the
  round trip that makes one tool feel like three.

  Split so that only the undecidable half needs a decoder. `frameGrabTarget` in
  `@nos/editing` answers *what* is under the playhead: the topmost enabled video
  clip, the source frame reached through exact rational seconds at the source's own
  rate and through the clip's speed, and a destination named after both so grabbing
  the same frame twice is one file rather than a pile. The sidecar's `/media/still`
  does the half that cannot be tested without ffmpeg, writing to a `.partial`
  neighbour and renaming — the folder is watched, and a watcher that sees a
  half-written PNG hands the browser a file it cannot decode. It refuses to write
  under `cache/`, because a grabbed still is an *input* a run is pinned to.

  Live: standing at frame 89 of a 30 fps clip, the button read *Grab frame 89 of
  withsound.mp4*, and `media/stills/withsound_000089.png` came back holding the
  frame the preview was showing.

  Harness note, since it cost three runs: `pkill -f electron` matches the shell
  command line issuing it whenever that line also mentions electron, so the kill and
  the launch must never share a command.

- 2026-08-08: Issues #12, #13, #15, #16 and #17.

  **#17** was the run path for the file input shipped an hour earlier, and had
  three faults. The upload read the project file *through the backend
  transport* — which in the desktop proxies to ComfyUI, so it asked the render
  server for a file on the local disk; that is what `a backend path must start
  with "/"` was refusing, correctly. The renderer→main proxy forwards only
  string bodies, so the multipart form was dropped in silence. And the name the
  backend stored the upload under was never patched into the graph: the patcher
  left a note saying the backend would finish the job, and it never did, so the
  node would have loaded whatever the graph's author last saved. A run that
  looks like it used your image and did not is worse than one that fails.

  **#16** and part of **#13** were the same shape as each other: capabilities
  that existed with no way in. Tracks could be added from toolbar buttons nobody
  looked at, so a right-click now offers them — along with renaming and deleting
  the lane it was opened on, which needed the menu to know its target rather than
  only a clip. The browser could show the project folder and do nothing to it, so
  it now makes folders, renames, trashes and moves by drag. The reserved folders
  are refused rather than confirmed: a dialog is a question with a wrong answer
  available, and renaming `media/` leaves every clip pointing into nothing.

  **#15** arrived with no description, so it was measured. The preview canvas
  overflowed its box by up to 149 px and painted over the status line — the
  `aspect-ratio` sizing fell back to the intrinsic ratio because a percentage
  height inside an auto-sized grid row is cyclic. Pinned and `object-fit`
  now, which cannot overflow at all.

  **#12** closed the gap that made generated output anonymous. Each file gets a
  provenance record beside it — generator, prompt, seed, every parameter — and
  the browser's detail pane reads it. A sidecar rather than an index because a
  project *is* a folder: move the file and its history moves; an index would be a
  second source of truth about files the user can move, and would be wrong within
  a day. Written for discarded variants too, since those stay on disk and would
  otherwise be exactly the anonymous files this exists to prevent.

  The browser rows also grew — 13 px type, roomier rows — on the report that it
  was too small to read. It is the panel scanned most often and it was the
  densest thing in the window.

- 2026-08-08: Image-to-video proven end to end, and timecode entry.

  The one thing left unverified after #17 was whether a generator with a file
  input had *ever* completed — the upload was broken in three places, so it
  cannot have. Run against the live ComfyUI: the frame was grabbed into
  `media/stills/`, uploaded, and the queued prompt's node 114 read
  `image: withsound_000000.png` — the name the backend stored it under, not the
  project path and not the placeholder. The job succeeded, the video was
  downloaded into `generated/`, and a provenance record was written beside it
  carrying the prompt, the seed and the first frame. The whole chain works.

  Then the sweep for tested-but-unreachable code turned up `parseTimecode` and
  `timecodeToFrames` with no callers: the transport's timecode was a `<span>`.
  The position was shown and there was no way to go to one, while "go to
  00:01:14:03" is what a note from someone else always says.

  `parseSeekEntry` decides what typed text means, and the point of it is that
  nobody types SMPTE. Partial entry fills digits from the right (`1215` is twelve
  seconds and fifteen frames), `+30` moves thirty frames, `250f` is frames, `.`
  and space work as separators because a keypad has no colon, and drop-frame is
  exact — including explaining a skipped label rather than looking broken. An
  entry past the end lands on the last frame, since typing past the end is how
  someone asks to go *to* the end.

  One correction along the way: my own test asserted frame 1798 for
  `00:01:00;02` at 29.97. The library was right and I was wrong — drop-frame
  skips *labels*, not frames, so that label belongs to frame 1800.

  Harness note: another session's Electron was running against the same project.
  `pkill -x electron` would have taken it down; instances are now killed by the
  debugging port they were started with.

- 2026-08-08: Segmentation, connected.

  The sidecar has implemented SAM 2 propagation since M6 — capabilities, start, a
  status poll, a cursored frame feed — and the panel asked it nothing. It
  reported `available: false` with the words "connect a project to check whether
  SAM 2 is installed", a placeholder that had outlived its placeholder-ness: a
  project *was* connected and it still said that. It now asks, and says what the
  engine actually answers, which on this machine is that `sam2` is not installed
  and how to fix it.

  Two things were wrong beyond the missing request. The session was built from a
  fixed three-hundred-frame span rather than the clip's own, so a propagation
  would have covered frames the clip never shows. And it was rebuilt inside a
  `useMemo` keyed on the playhead, so every placed point was discarded the moment
  the playhead moved — a second point could never be added.

  Placing points needed the session above both panels: the clicks land on the
  preview and the run starts in the inspector, and those are siblings. The
  overlay is sized to the *picture* rather than the canvas box, which is not the
  same rectangle — measured live at 919 px against a 1256 px box, so an
  aspect-blind overlay would have placed every point up to 27% out. That failure
  does not look broken; it looks like an inaccurate engine.

  One genuine bug fell out of watching it: the session's frame was not clamped to
  the clip. Selecting a clip that starts at frame 1032 while the playhead sits at
  0 stamped every prompt with frame 0 — a frame the clip does not contain — so
  the engine would have been asked to seed from a picture the user never clicked
  on. Clamped now in `beginSession` and `moveTo`, for the same reason
  `setPropagation` already clamped.

  Not verifiable end to end here: `sam2` and `torch` are absent from the sidecar
  environment, so the propagation itself has never run. Everything up to the
  request is exercised; the run is not.

- 2026-08-08: Issues #18 and #19.

  **#18** was reported as MiniMax's resolution being unsettable, and the cause was
  not MiniMax. ComfyUI declares an enum input two ways — options in place of the
  type, or a named `COMBO` with the options in the metadata — and only the older
  was understood, so against a current ComfyUI *every live dropdown in the
  application was empty*. Both are accepted now. The image-to-video manifest also
  had no resolution parameters at all; both now expose the `ResolutionSelector`
  their graphs already contained, and the aspect ratio defaults to the project's
  own shape through a declared `default_from`, matched on the logarithm of the
  ratio so tall and wide are equally near. The user asked for 0.2 megapixels
  mid-way; that is the default.

  **#19** was three faults in dragging, and the second was the serious one.

  *Nothing could change track.* The drag read `clientX` only, so the vertical axis
  did nothing at all. Worse, once it did work, the *common* case still could not:
  an imported video and its audio are linked, so grabbing either drags both, and a
  group move was deliberately pinned to its tracks. The row delta now travels with
  the group and is applied within each clip's own kind — a video moves down one
  video row, its audio down one audio row, and the pair stays a pair.

  *A blocked move was refused outright*, so the whole gesture failed and the clip
  snapped back: "there is room and I cannot use it". It now travels as far as it
  legitimately can. A drag along one track keeps a direction — dragged left, a clip
  must not land to the right of what blocked it — but a drag onto a *different*
  track has no direction, and restricting it there was what made dropping onto an
  occupied row fail. Verified live: pushed right 500 px, then dragged 3000 px left
  through the blocking clip, landing flush against it with no rejection.

  *A drop was a guess.* The lane now tints and a line marks the frame while the
  asset is still in the air, computed from the same function the drop uses so the
  two cannot disagree.

  The indicator's plumbing has no jsdom test and says so: there is no `DragEvent`
  there, so a synthetic `dragover` carries no `dataTransfer` and a test would pass
  for the wrong reason. `assetDropTarget` is tested directly; the rest was checked
  in the running app with a real `DataTransfer`.

- 2026-08-08: Issue #20 — a preset that sets rather than locks.

  Stable Audio's length could not be set, and the cause was a missing
  distinction. A preset carried one kind of value: `pin`, which is applied *and
  hidden*, so the panel reads as its own tool rather than the same form with
  different numbers. That is right for the category that makes SFX be SFX. It is
  wrong for a length: SFX and One-shot both pinned `duration_s`, so choosing
  either removed the only control for the thing the user most wanted to change.

  A preset now has `set` as well as `pin` — pre-filled and still editable, versus
  fixed and hidden. Layered defaults → set → pin, with the pin last because it is
  the value that cannot be argued with; otherwise a preset that did both would
  depend on which was written first. `visibleParams` had no test at all before
  this, which is how a rule this load-bearing went unexamined.

  Verified live: the length shows under every preset, pre-filled at 2 for
  One-shot and 50 for Music, and an edit to 12 under SFX holds.

- 2026-08-08: The roll edit, and re-linking.

  **Roll** was the last core edit missing. Trimming either side of a cut leaves a
  gap or an overlap; rolling moves the boundary, so one clip gains exactly what
  the other gives up and nothing downstream moves. Built on the two trims rather
  than beside them — they already know about handles, locks, keyframes and
  collisions — with this adding only what neither can know: that they are one
  gesture, ordered shorten-then-lengthen so the intermediate state is legal, and
  whole or nothing because a partial roll opens the gap it exists to prevent.

  The gesture is Shift on a trim handle. The cut is exactly where the two trim
  handles already are, so a roll strip wide enough to grab would cover one of them
  — losing head-trim on every flush clip is a worse trade than a held key. Only
  edges that really are cuts advertise it, from the same predicate the edit uses,
  so the tooltip cannot promise a gesture that refuses. Verified live: the cut
  moved 913 → 964 px, both edges flush, the sequence's extent unchanged.

  **Re-linking** closed an asymmetry: `linkClips` existed, tested, with no caller,
  so unlinking a pair was a one-way door whose only recovery was undo. The
  selection rule lives in `linkablePair` so the menu row and the action read the
  same thing, and it is resolved again at the moment of acting — the selection can
  change between opening a menu and choosing from it, and linking the wrong pair is
  worse than a row that turns out to do nothing.

  Probe hygiene: the scratchpad demo project now holds the user's own edit, so
  probes run against a fixture under the job directory instead. Earlier runs this
  session imported clips into that project and dismissed its recovery snapshot.
