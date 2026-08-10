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

A fifth check, cheap and repeatable: **count how many times a function name is defined.**

```
grep -rhno "^\(export \)\?function [a-zA-Z0-9_]*" --include=*.ts --include=*.tsx apps packages \
  | sed 's/.*function //' | sort | uniq -c | sort -rn
```

Test fixtures dominate the top and are fine. What is left has found, in two passes: four copies of the
edit-error describer — where improving one left the message on screen unchanged, because the keyboard
path used another — and four of `clamp01`, which had **already drifted**, three refusing a non-finite
value and the fourth passing it through. Duplication here is not a tidiness complaint; it is where this
codebase's real bugs have come from.

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

And there is a fourth, which found more than the other three put together: **run a real job against
the real backend and read every word the application says while it does.** Not "does it work" — it
did — but whether each sentence on screen is true. One Stable Audio submit produced five findings:

- The bar read `variant 1 of 3` while all three landed at once. A run is not a variant; a batched
  manifest puts every seed into one submit, and the label promised two more runs that never existed.
- The stage read `executing 30:3`. The graph we submitted knows that node as `KSampler`.
- `Keep` at a busy playhead said `the edit was rejected: collision` and stopped there. The rejection
  was right; having no answer to it was not.
- The new track it eventually made was called `a2`, under `A1`.
- `kept — …` was still on screen ten minutes later, under an error icon, with nothing to remove it.

None of these are visible to a unit test, because every one of them is a *true* statement about the
wrong thing, or a true statement with no way forward. The question that finds them is: after this
sentence, what would a user do next — and can they?

The same pass found the one outright hang in the system, by watching a run stay at
`VAE Decode · 1 running · 100%` for twenty minutes while ComfyUI, restarted underneath it, had an
empty queue and an idle GPU. The socket adapter woke only on a `message`, so a backend that went away
parked the progress loop on a promise nothing would resolve. **Any stream a job waits on must end when
its source dies**, or the job waits forever and reports nothing.

Six capabilities found this way and closed since: the audio engine's `scrub` — a grain with a fade at
each end, taking only the loudest source, on the hook's interface and never called, so §6.2's "audio mix
**and scrub**" was half built — `track.gain` and `track.pan` — the mix plan multiplied
one into every clip on the track and combined the other with each clip's, and both sat at unity and
centre for the life of every project — `Transition.params` — the compositor read it and the
built-in wipe declares a `softness`, so every wipe sat at the manifest default — `marker.label` and `marker.color` — drawn by the ruler,
round-tripped by `project.json`, settable by nothing, with every marker defaulting to a label saying the
timecode the ruler already states beside it — `clip.label` — the engine could rename a clip and the user
could not, so three kept variants of one generator shared a single name — and `track.collapsed`, which
round-tripped through `project.json` while nothing could set it or drew anything differently for it.
The sweep that finds them is one line: for each exported operation, count references outside its own
package and its tests.

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

- A value that can be dragged must also be **typeable**. §6.1 asks for frame accuracy,
  and a drag cannot land on frame 120 — nor say which frame it did land on. The typed
  path goes through the same operation as the drag, so both are one edit with one set
  of refusals.
- `slipClip` **adds** its delta to the source position, and takes it in **project**
  frames while `sourceIn` is in source frames. Any caller editing `sourceIn` directly
  has to convert; at matching rates that is the identity, which is exactly why getting
  it wrong survives until someone tries 24-into-30.
- There is **one** shell describer, in `renderer/edit-errors.ts`. There were four copies
  of this function; two were the same fallback written twice, and the one the keyboard
  path used was not the one improved first — so the message on screen did not change
  until the fourth was found. Every kind gets a sentence, lower case, carrying the
  numbers that make it actionable.
- The shell's `describeEditError` is deliberately not the domain's. The domain's is
  exhaustive over `EditError` and **throws** on an unknown kind — right for a package
  that wants a compile error when a case is added, and wrong for a UI that is handed
  transition and segmentation errors too, where it turns a refused edit into a blank
  window.

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

### Round-trip rules (keep these)

Two formats in this project are written by hand and read back: `project.json` and a generator
manifest. Both have a round-trip test that saves a rich fixture and compares what comes back. Both
tests were **blind in the same way**: they can only check the fields the fixture happens to set, so a
field added to the model and forgotten in both the writer and the fixture round-trips perfectly by
being absent from both sides.

**So the fixture is checked too.** `every-field.test.ts` — one in `@nos/core`, one in `@nos/generators`
— reads the property names out of the model's own source and asserts each appears in what was written.
A field missing is either not serialized or not exercised, and from a user's chair those are the same
bug: the setting they made does not survive closing the project.

Two consequences worth stating:

- **A default is not exercise.** The serializer omits a value equal to its default, so a flag written
  only at its default never reaches the file and proves nothing. Every flag is set away from its
  default *somewhere* in the fixture. `track.muted` was the last one that was not.
- **Exemptions name interfaces, not fields.** A field-name exemption silently covers any future field
  that shares the name. There are three in total across both checks, each with its reason, and a test
  asserts the list stays short.

**What this found immediately, in shipped files.** `GeneratorParam.options` may be a fixed list *or*
`{ from: 'capabilities' }` naming a node class and input — three of the five shipped manifests use the
second for their sampler, scheduler, LoRA and aspect-ratio dropdowns. `ManifestDraft` typed it as a
list alone, so opening one of those manifests in the inspector and saving **deleted the source**, and
the validator — written around `.length` — reported four perfectly good dropdowns as "an enum needs
options". `shipped-manifests.test.ts` now drives every real file in `generators/` through the
inspector and back, which is the check that would have caught all three previous losses.

**A type you can pick and cannot finish is worse than one not offered.** `enum` was in the inspector's
type list with no field for its choices anywhere on the panel, so choosing it raised an error nothing
on screen could clear, with Save disabled the whole time. Fixed by a choices control that offers both
shapes as one mode switch.

**Which fields a parameter has is data, not a chain of conditions in the panel.** The row had grown to
four of the format's ten — key, type, min, max — each added where it was needed, so the *set* was
never visible anywhere and the missing six were invisible with it. A manifest authored in the
application came out with no labels, no defaults, single-line prompt boxes, and no `transport`, which
is the whole of how an image parameter reaches the backend: §5.9's "authored from inside the
application" held only in the sense that a file appeared. `fieldsFor` in `@nos/generators` now decides,
so a new parameter type is one entry there and arrives with the right controls everywhere.

A field still appears only where it means something — a minimum on a boolean, a line-wrapping flag on
a number, an upload transport for an integer are all controls that do nothing, and a panel offering
meaningless fields teaches the user to ignore all of them. A seed deliberately has no default:
varying is the point of one.

**An absent value and a falsy one are different gestures.** No default lets the graph's own value
stand; a default of `0` or `false` overrides it. Both are offered, and `required` is *cleared* rather
than written `false`, because the format treats absent and `false` alike and the second puts a field
in every manifest that every reader has to skip.

**Controlled fields cannot be tested against a mock.** Every field here is driven by the draft, so a
handler that never updates it leaves each keystroke landing in a field that re-renders to its old
value — only the last survives, and the test reads a value nobody could have typed. `renderLive` in
the panel's test wires real state; anything typing more than one character goes through it.

**A field that re-renders from parsed state cannot be typed into.** The choices field derived its text
from the parsed list, so the comma between two values was swallowed the instant it was typed and a
second value could never be entered. It holds the typed text and writes the draft on each keystroke,
re-seeding only when the stored list is not what the field spells. Only driving the control found this
— the pure functions under it were all correct.

### Story board rules (keep these)

Issue #33: a plan on the same clock as the cut. A beat says *when* something should happen, *what* it
is in prose, and *what it should look and sound like* by pointing at material already in the project.
A plan, not a render — nothing here is composited, exported or mixed.

**In the document, not beside it.** Intent that lives outside the project goes stale the first time the
folder moves, and §4 promises that zipping the folder moves the whole project. It also means undo,
autosave and crash recovery are already answered: a plan stored anywhere else would be the only part of
the editor where a mistake could not be taken back.

**A span, not a point.** A marker says "here"; a beat says "through here", which is what describing a
shot that runs three seconds needs.

**An accent index, never a colour.** A stored `#3b82f6` would be the one place naming a colour outside
the palette — unreadable in a theme it was not chosen for, and exactly what the theme audit exists to
catch. An accent indexes the categorical roles, so a board coloured under one theme stays legible under
all six. Validated as one of five, because a sixth renders as no colour at all: a beat that draws as
nothing, in a file that loaded without complaint.

**Markdown, not a form.** This is the text a generator prompt is later written *from*, and fields for
camera, subject and mood would decide in advance what a shot is allowed to be about.

**No `Result` on the operations.** Beats may overlap — two ideas about the same three seconds is a
normal state for a plan — so there is no collision to report, and an error branch that never happens is
one readers learn to ignore.

**Sorted on read, not on write.** A beat being dragged passes through every position between where it
was and where it lands, and a list that reordered itself under the pointer is the one behaviour a
timeline must not have.

**Ids carry the frame they were made at.** A random id would make an unchanged project serialize
differently on every run, which is unreadable in version control.

`beatReferences` is deliberately named apart from the document's own `referencedAssets`: a beat's
references are material the *cut* may never touch — that is the point of a reference — and conflating
them would make "unused" mean different things depending on which a caller reached for.

The `every-field` guard caught the new fields the moment they existed, which is what it is for: the
rich fixture carries two beats, one with every field and one with only what a freshly dropped beat has,
because both shapes have to survive a save and the second is the common one.

### Panel tab rules (keep these)

Issue #29: the right column had one `inspector` tab holding a clip's name, its timing, its framing,
the effect stack, the transitions, the audio mix, the project's settings *and* the application's. Most
of it is irrelevant to whatever the panel was opened to do, and a stack that long buries the control
you came for. Now: **Clip · Effects · Generate · Variants · Segment · Project**, as line tabs across
the full width (#30) — the active tab's underline and the row's own border are one line, so the row
reads as the panel's top edge rather than as a floating group of buttons.

**Tabs are data.** `PANEL_TABS` decides the order, the label and which clip-inspector *sections* each
one shows. Adding a tab used to mean editing three places — the union, the trigger list and the
content list — and is now one entry.

**Sections, not components.** The clip inspector covers six unrelated concerns, and splitting the
component six ways would scatter the rules that keep them consistent. It takes a set and draws what it
is asked for; `sections === undefined` still means all of them, which is what a one-column caller
wants.

**Two checks make the split safe**, and both are worth keeping: every section appears on *some* tab —
one left out is a control that silently vanished from the application — and no section appears on two,
because two stacks editing one clip means the second looks stale the moment the first is used.

**Actions belong to the clip, and only to it.** Split, delete, nudge, copy a look, add a title: none is
an effect. Ungated they drew under the effect stack as well, which is exactly the "irrelevant content"
the issue is about — and it took a screenshot to notice, because nothing about it is wrong enough to
fail a test.

**The harnesses name tabs, so they had to move too.** `smokecheck` drove `inspector` in six places;
the settings checks are on `Project` now and the effect-editor entry on `Effects`. A harness that
names UI is a harness that has to be edited when the UI is right to change — which is the cost of
checking the assembled application, and worth paying.

### Opening a file (keep these)

Issue #32: double-clicking a `.frag` said *"…is not something that can go on the timeline"* — true, and
it left the user nowhere, because the shader editor existed and the only route to it started with
selecting a clip. A project folder is not only a bag of media; some of its files are **sources**.

**A table, not a chain of ifs.** `actionFor` maps an extension to what to do — timeline, a tab of a
given kind, or an honest nothing. Every new editor is a row, and the browser stays ignorant of what a
`.frag` is.

**A shader opens the effect, not the file.** A `.frag` is half of an effect and the editor holds both
halves, so the manifest naming it decides which effect opens. Matched by what the manifest *names*
rather than by the `<id>.frag` convention, because a manifest may name any shader beside it. One
nothing claims is an orphan — real while a shader is being written — and opens as text instead.

**Reachable without a clip.** The empty state offers the editor now. A feature whose only entry point
requires an unrelated selection is one nobody finds.

**Highlighting is written, not vendored.** The renderer runs under a CSP that forbids fetching, so a
library would have to be vendored; what is needed is a JSON tokenizer, which is small and testable. It
emits **tokens, never HTML** — an escaping bug in a highlighter is an injection bug in an editor that
opens files from disk — and it is tolerant, because a file being edited is malformed most of the time.
It must cover every character, whitespace included: the coloured layer sits *under* a transparent
textarea, and a dropped space puts the caret on the wrong glyph.

**Emphasis, not hue — and that is measured.** Highlighting wants a categorical palette and shadcn's is
the chart ramp, which this application forbids as text because it runs to 1.42:1 across the six
themes. `primary` fails too: 17:1 in five themes and **2.49:1** in the one the editor opens in. Only
`foreground` and `muted-foreground` clear AA everywhere, and `destructive` means an error. Two tones
and a weight is what this palette can honestly carry.

**Saving invalid JSON is refused**, because that is how a project stops loading — and the editor can
see it before the file exists.

**Only media is probed.** The detail pane probed whatever was selected, so clicking a shader or a
manifest sent ffprobe a file it cannot read and the sidecar answered **422** — a request that could
only fail, on every selection. Found by driving the browser right after source files became openable,
which is when people start clicking them.

**A harness section restores what it disturbs.** The new checks opened tabs and left the workspace on
one, and two later checks failed because the panel's tabs are not on screen while an editor tab is
showing. Ordering them last and putting the state back is the same discipline the backend-address
check already follows.

### Workspace tab rules (keep these)

Issue #31 asked for tabs at the framework level; #30 for line tabs spanning the full width. Both are
the same bar, and it is the **topmost** thing in the window: everything below it belongs to the active
tab, including the title bar, whose actions are the *editor's* actions. A first attempt put the bar
under the title bar, which made a tab govern a strip in the middle rather than the window — and the
user said so.

**The status bar stays outside the tabs.** #22 asked for a persistent bottom row showing what is
running in the background, and a generation that vanishes because you opened a shader is exactly what
that bar exists to prevent.

**Kinds are data.** A kind decides a tab's title, its icon and what it renders; adding one is an entry
in `WORKSPACE_TAB_KINDS` plus a line in `TabGlyph`. The bar itself never learns what a kind means — it
takes an id, a title and whether it closes.

**The editor tab cannot be closed.** It is the application. A window with no tabs needs an empty state
that is really a fourth layout nobody asked for, and "close the last tab" has no good answer.

**Identity is kind plus subject**, so opening the same effect twice focuses rather than duplicates —
two tabs editing one effect lets a user make two sets of changes and lose one on save, silently. A tab
with *no* subject is always new, because two unnamed effects are two effects.

**Closing focuses the tab to the left**, which is where the eye already is.

**The editor content is hidden, not unmounted.** Unmounting drops the preview's GL context and every
scroll position in the window, and rebuilding them per tab switch is both slow and visible.

**And the gap tabs closed:** `EffectAuthoring` could already reopen an existing effect — it takes an
`editing` id — and *nothing ever passed it*, so the capability shipped unreachable the day it was
written. This is the sweep's own pattern, found in a feature one round old. Effect rows now offer an
edit control, and only for effects the project owns: a builtin has no file to open.

### Effect editor rules (keep these)

Issue #28. §6.3 has always defined an effect as a GLSL fragment shader plus a manifest and §4 has
always reserved `effects/` for both — so the *format* was reachable and the **authoring** was not: a
text editor, a guess at the schema, a reload, and a drag onto a clip to find out whether it compiled.

**The preview is the feature, not the decoration.** GLSL has no useful feedback loop otherwise, and a
cycle that long is one where people stop making small changes — which is how shaders are actually
written. It draws on a real WebGL2 context through the compositor's own `assembleFragmentShader`, so a
shader that draws here is one the compositor accepts and a diagnostic here names the line the author is
looking at. A second, editor-only compile path would drift, and the day it did the editor would call a
shader good that the compositor then refused.

**The test frame has to make an effect visible.** A flat colour hides anything positional and a
photograph hides anything subtle: squares give edges, the gradient gives every luminance, and one
transparent corner over a checkered backdrop shows what a shader does to **alpha** — the thing most
first drafts get wrong, and invisible on an opaque background.

**Both files, shader first.** A manifest naming a shader that is not there is a *broken* effect in the
registry; a shader nothing names is a file nobody reads. If the second write fails, the worse state is
the one that did not happen.

**Save is gated on the contract *and* the compile.** Either alone is not enough: a draft that satisfies
the schema and does not compile is an effect that breaks the frame it is dropped on, and one that
compiles with a duplicate uniform is a control that silently does nothing. Both are visible before the
file exists.

**Samplers follow the kind.** They are what the compositor binds — an effect reads the frame so far, a
transition reads the two it blends. Left alone, switching kind produced a transition reading `source`,
which compiles and renders nothing.

**Checked in `smokecheck`, because every claim needs a real driver.** jsdom has no WebGL2, so a
component test can only assert the panel reports itself unavailable — the one state that does not
matter. Five checks: the starter shader previews, a broken one reports against **line 1**, Save is
refused while it will not compile, both files are written, and the effect is in the library without a
restart.

Two notes from driving it. `readPixels` on the preview canvas returns zeros once the frame has been
composited — without `preserveDrawingBuffer` the buffer is undefined — so the harness screenshots it
and asks the question the user asks. And Playwright matches an accessible name by substring, so a
loose `Id` inside the editor also found the media browser's `Only video` filter behind the dialog:
scoped and `exact`.

### Manifest authoring rules (keep these)

**Saying what a save would replace.** A manifest is written to `generators/<id>.manifest.json`, so the
id *is* the filename and two generators cannot share one. The screen wrote that path unchecked: typing
an id the library already had replaced a working generator — including one that ships with the project
— silently and completely. An id is a short slug with nothing on screen to say what is taken, so it is
not an exotic mistake.

A warning and not a refusal, for the same reason as the export dialog: replacing on purpose is exactly
what saving a manifest you opened *is*. The screen names what would go and offers a free id in one
click. Ids are suffixed `_2`, not ` (2)` — an id appears in a filename and in a clip's provenance, and
a space or a bracket in one is a difference every consumer has to think about.

**`editing` is the id, not a flag.** Reopening a manifest and saving it must not warn. Reopening one
and *renaming* it onto another must, because that is authoring a new manifest under a taken name — a
boolean cannot express the difference.

**Absent means "not known".** A screen that has not read the library does not claim an id is free.

**Assert the path that is written, not only the warning.** Nothing in the type system connects "the id
this warned about" to "the path this wrote", so the two can drift into a screen that warns about one
manifest and replaces another. `manifestFileName` is the one home for the name, and the test asserts
what reaches the bridge.

Two notes from getting there. The first drift mutant was **equivalent** under the fixtures —
`editingId ?? draft.id` is `draft.id` when nothing was opened — and passed while proving nothing; the
mutant has to differ in a case the tests actually cover. And the first version of the write test
clicked a *disabled* Save and read an empty list: `draftHasErrors` gates it, and an empty draft has
three errors, so a test that means to save has to complete the draft first.



§5.9 says a new generative capability is a JSON file authored from inside the application, with no
code. It now is. Every field of `GeneratorManifest` has a control, and the claim is checked rather
than asserted: `ManifestInspector.test.tsx` holds a `Record<keyof GeneratorManifest, …>` mapping each
field to the label of the control that edits it, so **TypeScript fails the build** when the format
gains a field nobody answered for. A runtime list has to be remembered; a parameter having four of ten
fields is what remembering looks like in practice.

What had no control at all, and what each cost:

- **`presets`** — the mechanism that makes one graph feel like several tools, and two shipped
  manifests carry six between them. A generator authored here had none and no way to get any.
- **`batch`** — how several variants go in one submit. Absent means sequential runs, so anything
  authored here always took the slow path.
- **`exclusive`** — parameters that are alternatives. Everything authored here kept every parameter
  independent, which is what every manifest written before the field existed did.
- **`outputs[].format` and `[].optional`** — three of five shipped manifests declare a format.
- **`consumes[].required`**.

**A preset asks for a role, not for two records.** The file stores `pin` and `set` and a parameter
must never be in both; asking which of *free / fixed / pre-filled* makes that impossible to express
and puts the distinction in front of the author. It matters because confusing the two is a bug this
project has already had: every value became a lock, and a one-shot preset that pinned its length left
no way to ask for a slightly longer one — the control was gone rather than pre-filled. The role
options are named by what they do, because "pin" and "set" are the file's words and say nothing to the
person choosing.

**Preset rules live in `validateDraft`, not beside the panel.** A second list rendered next to the
first would show an error beside an enabled Save button. Duplicate ids and empty names block; a preset
naming a parameter that has since been renamed only warns — the file is still valid, the value is
still there to be re-pointed, and refusing to save would trap someone mid-rename.

**Under `exactOptionalPropertyTypes`, clearing a field means dropping the key.** Setting it to
`undefined` is a different type and reaches the file as `null`, which the schema rejects on the way
back in — so the inspector would write a manifest it could not reopen.

**Label a preset row by the parameter's key, not its display label.** The key is what the preset
stores, a label is free to be blank or to repeat, and the display label collides with the graph-input
list beside it.

### Generator framework rules (keep these)

**A badge has to track the user's state, not just the data.** After keeping a take, three really are
still available — so the count kept saying three and the tab nagged until the group was dismissed. A
badge exists to say *there is something here you have not dealt with*, and a kept take has been dealt
with. `waitingTakes` takes the groups already answered; the picker is untouched, so keeping a second
take from the same batch still works.

Whether a person has made up their mind is not a fact about a job, so the answered set lives in the
runtime hook rather than in the queue — and `dismissGroup` forgets it, or the set grows for the life
of the session with ids nothing can name.

**"Discard" beside a per-variant "Keep" reads as *discard this variant*, and it was not** — it
dismissed the whole group. Someone rejecting take 2 to compare 1 against 3 pressed it and lost the
picker. It says **"Dismiss all"** now, and the tooltip says what survives: everything, since the files
stay in `generated/`.

**One number, one derivation.** The count was computed in the panel *and* in the shell, and they
drifted the moment one learned about answered groups: the sentence fell silent while the badge went on
saying three. Driving the real loop is what showed it — the unit tests were green throughout, because
each derivation was correct on its own. The shell computes it; the panel takes it as a prop.

**A run submits the values the panel is showing, not what the user happened to type.** `onRun` took
no argument, so the caller reassembled the parameters from its own state — which holds only what was
*typed*, while the panel renders and validates `defaults + derived + typed`. The two diverged and the
consequence was invisible from both ends: the submit still reached the backend correctly, because the
manifest's defaults are applied downstream, but the **group recorded the un-defaulted set**. A
declared-length manifest sizes its placeholder from the group, so Stable Audio generated its default
fifty seconds and the clip landed **two** seconds long — the `discovered` fallback — with forty-eight
seconds of the take unreachable. The panel hands its effective values over now.

Found by driving the whole loop and comparing what was on disk with what was on the timeline: a
49.97-second FLAC beside a 60-frame clip. Neither number is wrong on its own, which is why nothing had
caught it.

**A finished run has to announce itself.** Found by driving a real generation against the live ComfyUI
and reading every word: three takes landed in twelve seconds and the application said *nothing*. The
generate panel was unchanged — same "ready", same "Generate 3 variants" — the tab holding them read
`Variants` whether it held three or none, and the status bar said "Idle". The obvious next action was
to press Generate again, which is how `generated/` ends up with sixty takes of which the cut uses two.

Three changes, in order of how long they last: the **tab carries a count** (`Variants 3`), which is the
standing signal; a **sentence once on the transition** to having takes — "3 takes ready — pick one in
Variants" — which says what to do next without nagging while the user decides; and the status bar says
**"1 done"** rather than "1 task" when nothing is running, because "Idle · 1 task" reads as a
contradiction.

Not a tab switch. Moving the panel out from under someone mid-edit is worse than the silence it fixes.

**The count and the picker are one derivation.** `currentSelection` and `waitingTakes` live in
`@nos/generators`, and the panel uses the first while the tab uses the second. A badge saying three
beside a panel showing two is worse than no badge, so a test asserts the two agree — and a batched
submit counts as the takes it carried, not as one run.

Verified against the running application and the real ComfyUI: `Variants 3`, the sentence, `Idle · 1
done`, three FLACs with provenance sidecars, no page errors.



- Parameters that are **alternatives** are declared, never inferred. §2.3's voice is an enum or a
  sample, one of the two; guessing the pairing from types or roles would silently group parameters
  nobody meant to group, and a manifest that declares nothing must behave exactly as it did.
- Choosing an alternative **clears the others**. A submit carries whatever the parameters hold, so a
  leftover value reaches the graph beside the one the user actually picked.
- A required either/or that nobody answered **refuses the run**. Submitting neither leaves the graph to
  decide, which is the ambiguity the group exists to remove.

- A round trip through the inspector must **lose nothing**. `fromManifest` dropped `also`,
  `defaultFrom` and `durationFrom`, so opening one of the project's own MiniMax manifests and saving it
  deleted the `fps` length expression — silent corruption of a file the user already relies on.
- A round-trip test is only as good as its **fixture**. The existing one asserted equality and passed
  for months because it omitted exactly the fields being dropped. A fixture for a preservation test
  has to carry every optional field, especially the rare ones.
- Preserve first, then author. Carrying a field through the draft is what stops it being destroyed;
  a control is what makes it reachable. The two are separate problems and the first is the urgent one.
- Clearing an optional field **removes the key** rather than setting it to `undefined`, and an empty
  list is removed rather than written — the manifest writer distinguishes absent from empty, and a
  reader should not have to skip fields that mean nothing.

- The inspector must be able to author **every** field the framework reads. `consumes` was written
  verbatim from a draft value with no control, so everything authored there declared it consumed
  nothing — and §5.2 derives the surfaces from exactly that field. "Kódírás nincs" fails wherever a
  field has no control.
- Inputs are **suggested from the parameters**, not asked for twice: a parameter of type `image` is a
  generator taking an image, and asking again invites the two to disagree. The role is the part no
  derivation can invent, so it stays editable and defaults to the parameter key `inputFor` matches on.
- A field belongs to the type that reads it. `sources` on an image input is a field every reader
  ignores and the next author has to explain away.

- A text parameter's **sources** are honoured, per §10: typed, a `notes/` file, or a text clip. The
  field was declared, parsed and carried through the manifest layer while nothing read it, so a script
  already written could only be voiced by typing it again.
- A manifest that declares no sources gets `inline` **alone**, never all of them. It is asking for a
  value; offering to bind it to a timeline clip invents an intention its author never expressed.
- An unrecognized source is **dropped, not rejected** — the same forward-compatibility rule the
  registry applies to unknown node classes — and the list never comes back empty, because typing works
  for every text parameter by definition.
- A binding is kept and **re-read at submit**, not copied once. Reading at binding time is how a tool
  ends up confidently generating from yesterday's draft; a source that has since gone refuses the run
  with a reason rather than running with the stale value.
- Resolution lives in the shell, never in `@nos/generators`: that package has no filesystem and no
  document, and it is what keeps a fourth source from reaching into it.

- The job queue belongs to the **project**. A take is a file in that project's `generated/` folder and
  an accepted variant carries a project-relative path, so a group surviving a project change offers
  variants whose files are not where the new clip would look — with a picker that looks normal.
- Clearing **cancels before it forgets**. Forgetting alone leaves runs burning the GPU for results
  nobody can reach, and the snapshot looks identical either way — which is why a test that asserts on
  the snapshot cannot tell the two apart. Assert on the backend's cancellation record.
- A test that passes against the mutant you are guarding against is not a test. Every check written
  here should be run once against a deliberately broken version before it is trusted.

- The GPU semaphore serializes **every** consumer, not just the queue. `GpuConsumer` named four and
  tests exercised four; production acquired with one. A lock only one caller takes is not a lock.
- A shared resource must be created **once per window**, outside any memo whose dependencies can
  change. Built inside the job queue's `useMemo`, the semaphore was replaced when the backend flipped
  from mock to ComfyUI, and a lease held against the discarded instance guarded nothing.
- `withGpu` fits work that is one `await`. Segmentation is a POST plus a poll, so the lease outlives
  the call that took it and is released from every exit — including the terminal poll, without which
  one propagation holds the card for the lifetime of the window.
- Waiting for the GPU is a **named state**, not a progress fraction of zero. With the lock in place
  waiting is normal, and silent waiting is indistinguishable from a hang.
- An id for a job identifies **one attempt**, not one output. Deriving the encoder job id from the
  output path and frame count made every export after the first collide with it, and the sidecar
  refused the duplicate while the dialog sat at zero.
- Existing is not finished. ffmpeg creates the output when it opens the muxer, so a check that reads
  the file as soon as it appears reads a header with no frames behind it.

- Unaccepted variants stay on disk by design, so something has to be able to **remove
  them later**. `generated/` reached 63 MB across 39 takes in a day of use, of which the
  sequence used one.
- A bulk removal answers only about **candidates it was given**, so it cannot propose a
  file it was never told about. What is eligible is the shell's question — only it can
  read a folder — and what is *used* is the document's: a clip's source or a mask's
  asset.
- The browser's tree is **not** the place to ask what is on disk. It hides `.nos.json`
  records deliberately, so a rule that needs them finds nothing; read the folder.

- Generators are read from the project's folder **and the shared library**, per §5.6, with
  the project winning on an id collision — a project shipping its own version of a
  generator means to use that one. Reading the library needs its own channels: the project
  ones resolve against an open project, and the case that matters is having none.
- A library path is still a path a renderer asked for. `..` from the library root reaches
  the rest of `userData`, the session file included, so its handlers are guarded exactly
  as the project's are.
- A loader that promises **not to throw** must wrap the bridge call, not `.catch()` it. A
  bridge missing a method throws *synchronously*, which a promise catch never sees — what
  a stub bridge in a test does, and what an older preload would do.
- A folder the application reads from has to be **named on screen**. One written down
  nowhere is one nobody puts a file in, which is the shared library reduced to dead code.

- Provenance exists to be **fed back**, not only read. `recallRun` turns a record into a
  request: with the seed it reproduces, without it only the seed moves and everything
  that made the take is kept.
- A recall must **name what it dropped**. A manifest is a file a user edits, so by the
  time a take is recalled a parameter may have been renamed and a preset deleted, and
  silently dropping them sets up a run that is not the one the user pointed at.
- Reproducing writes the seed into the **parameters** as well as pinning it. The record
  keeps the seed in its own field, so pinning alone left the lock on and the field
  showing its default — the run using one number while the panel said another.
- A panel whose tab the shell needs to switch must be **controlled by the shell**. Owning
  it locally and reporting changes upward gives the shell a mirror it can write to with
  no effect, and the actions that switch tabs fail silently.

- A variant is identified by its **candidate key**, never by its run. A batched submit
  is one run carrying several variants, so a run id names all of them at once — and
  since no key ever equals a run id, code that mixed them up silently fell back to the
  first variant instead of failing. It cost the arrow keys entirely: they did nothing
  for every batched group, which is what the audio manifest produces by default.
- Tests for anything that walks variants must include a **batched** fixture. Three
  separate runs give every candidate its own run id, so run and key discriminate
  identically and the whole class of bug is invisible.
- The selection changes through **one channel**. Reporting a delta and letting the
  caller work out which candidate it landed on is what let the two implementations
  disagree; stepping is a pure function of the selection, so it belongs beside it.

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

- The event socket must end its stream on **close and error**, not only on a message.
  A backend that restarts mid-run otherwise leaves the progress loop awaiting a promise
  nothing resolves, and the run stays "running" for the rest of the session with no
  error and no collection attempt. Ending is not failing: collection is still tried,
  because a socket that dropped after the last node ran has outputs in the history.
- The `executing` event names a node by **id** (`30:3`, or `54:14` inside a subgraph).
  Resolve it through the submitted graph's `_meta.title` before showing it. Keep those
  names **per job** — ids collide between graphs.
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

### Process lifetime rules (keep these)

- A child process must **end itself** when its parent dies without stopping it. `before-quit` covers
  every ordinary close and none of the others; a killed shell otherwise leaves a sidecar holding its
  port, its memory and whatever the segmenter left in VRAM.
- The portable signal is **stdin end-of-file**, not a parent pid. `os.kill(pid, 0)` is POSIX and
  Windows Python does not implement signal 0, and pid reuse makes the check wrong in principle. A pipe
  the operating system closes needs no dependency, no polling and no permissions — but the parent has
  to actually give the child one, so `stdio` passes a pipe rather than `ignore`.
- The watchdog is **opt-in**: a sidecar run by hand may have stdin on /dev/null, which is end-of-file
  immediately, and an unconditional watch would make the service impossible to debug.
- Orphaned processes are not a tidiness problem. One took a port and the failure surfaced in an
  unrelated tool with a message pointing nowhere near the cause.

### Opening a project (keep these)

**Read the document before anything switches.** The shell made a project current and *then* parsed its
`project.json`. A file that failed to validate left the editor showing an empty timeline under that
project's name with Save enabled — and one click replaced a broken-but-repairable file with an empty
`Untitled`. Driven against the running application before it was changed: the header claimed the
project was open, Save was offered, and the click destroyed it. A project that cannot be read now never
becomes the open project; nothing switches and the previous project stays exactly as it was.

**Say which file and why.** `describeLoadError` names the offending path — the same reasoning as the
spec's requirement that a broken manifest names its broken pointer — and the shell threw all of it
away for "project.json could not be read". The dialog now shows the reason verbatim
(`frameRate: expected string, got number`) and offers to reveal the file, because the file is still
there and repairing it in a text editor is the only actual way forward.

**A refusal needs its own state, not the notice stream.** Notices are cleared by the next successful
edit, so the one message that must survive until the user acts on it cannot live there.

**This is checked in `smokecheck`, not in a unit test**, because every part of it is a fact about the
assembled application: which name the header shows, whether Save is offered, and what is on disk
afterwards. Four checks, all three failure modes verified against the code as it actually shipped —
the adoption, the missing explanation, and the overwrite.

One note on the mutant: a first attempt left the dialog in place, and the file survived only because
the modal blocked the click. An assertion that passes for an incidental reason is worth less than
none, so the mutant was made faithful — no dialog, adopt first — and only then did the overwrite
assertion fire.

**`migrationsApplied` now has a reader**, though it cannot fire yet: `MIGRATIONS` is empty at schema
version 1. Wired ahead of the first migration rather than left as a gap, and said plainly, because a
path that has never run is exactly what this document keeps recording.

### Project rules (keep these)

- A renderer **cannot name a file on disk**. Electron removed `File.path` so that naming one is a
  privilege the preload grants; `webUtils.getPathForFile` is synchronous and not a channel, because it
  reads nothing the renderer did not already hand over.
- Two routes to the same effect share one routine. The chooser and the drag differ only in how the
  paths were picked, and separate copiers would eventually name files by different rules.
- Settings that belong to the **installation** live beside `session.json` in `userData`, never in
  `project.json`: a cap on how much work a machine takes on follows the machine, not the cut. §5.8's
  global variant override was declared in the queue and unreachable for want of anywhere to put it.
- A default is stored as **absent**, never as a copy of itself. Writing today's default into every
  settings file freezes it there, and clearing a field then has no way to mean "whatever the default
  is now". §3's backend address is empty by default for exactly this reason.
- Precedence for a configurable endpoint: the **user's setting**, then the environment, then the
  built-in. The environment still beats the built-in so a scripted launch keeps working; the user's
  choice beats both, being the more deliberate.
- A stored URL's **scheme is checked**, never assumed. A settings file is the kind of thing that gets
  pasted into, and a `file:` or `javascript:` address would be handed straight to `fetch`.
- An address commits on **blur**, not per keystroke: `http://1` is valid and would be stored, walking
  the backend across a dozen machines on the way to the right one.
- Settings are read **tolerantly, per field**, so one hand-edited mistake does not cost the rest — and
  so a file from an older build simply has defaults for what it does not mention.
- A number out of range is **clamped, not discarded**; something that is not a number is. The first
  says what the user wanted, the second says nothing.
- The **main process may import types from the workspace packages, never values**. It is loaded as
  source rather than bundled, so a value import fails to resolve and the application does not start at
  all. Put the rule in the renderer and leave the privileged parts — dialogs, filesystem — to main.
- Importing **copies**. A reference to somewhere else on the machine breaks the zip-and-move promise
  invisibly: the cut plays until it is opened elsewhere.
- A free name is numbered **before** the extension, from two, and resolved against the folder *and the
  rest of the batch* — two cards each holding `shot.mp4` is an ordinary import.

- **Media can leave.** A project is a folder, so a clip's file can be renamed, moved or unplugged. The
  document keeps the project-relative path; whether it still resolves is a question about the *folder*,
  derived from the tree — never stored, because it is true of one machine at one moment.
- A tree not yet read reports everything **present**. Announcing that every clip is offline for the
  second before the first scan lands is a false alarm when the user can least judge it.
- A **relink is by asset, not by clip**: the file moved once and the cut did not change, so every clip
  reading it follows, in one undo step. Per-clip would mean fixing a bed used nine times nine times.
- It changes **only where the file is**. Someone who moved a file into a subfolder has not asked for
  their trims back.
- Candidates match on **file name** and rank by how little of the path changed — but a guess is offered,
  never applied, and the dialog says how many clips will follow before anything is chosen.
- Any picker over project files offers only what the application could **type**. `project.json` as a
  replacement for a clip, or as a script, is offering a mistake.
- Missing media outranks every other notice: a proxy still shows the picture, a missing file shows
  nothing. And it **names the file** — a count sends someone hunting.

- §4's "zip the folder and you have moved the project" holds only while **nothing** writes a path
  outside it. `assetPath` refuses an absolute path at the brand constructor, which covers the document
  — a planted one stops the project opening at all — but the provenance sidecars, mask records, cache
  metadata and the rendered mixdown never pass through it.
- The guard therefore reads a **finished project on disk**, which is the only place every writer meets.
- Graph pointers are excluded by shape, not by guessing: a JSON-Pointer starts with a node id (digits,
  optionally with a colon), a filesystem path with a directory name.

### Export rules (keep these)

**An export says before it replaces a delivered file.** The encoder passes `-y` — right for a
deliberate re-render — and the dialog offers the same `renders/<project>.mp4` every time it opens.
Between the two, a second export silently destroyed the first: minutes of GPU time, and often the only
copy of a finished cut. Everything else in this application refuses to destroy without a word — an
import skips a name already taken, a delete goes to the trash — and export was the one place where
losing something cost the most.

A warning and not a refusal: re-rendering over a take is an ordinary thing to want, and an export that
*could not* overwrite is one people work around by hand. What was missing is the word, so the dialog
says what will happen and offers a free name in one click. The naming rule is `uniquePath`, beside
`uniqueName` in `@nos/media`, so a delivery is numbered by the same convention as an import rather
than by a second copy of it.

**The set is optional and absent means "not known".** A caller that has not read the folder must not
be forced to claim the file is absent, so nothing is said.

**Checked in `exportcheck`, not only in a component test.** The warning depends on the *watcher*
having reported the file the export just wrote; a component test supplies that set directly and would
pass with the folder never read at all. The harness already exported twice — and deleted the file
first, which is exactly why it never saw this.

**Playwright matches an accessible name by case-insensitive substring.** The fixture project is called
`exportcheck`, so the new "Save as exportcheck (2).mp4" button matched a loose `{ name: 'Export' }`
and broke a check that had nothing to do with it. Every `Export` selector in that harness is `exact`
now; a loose name is a selector waiting to catch a label nobody has written yet.



- A **review copy** renders smaller *and* reads the proxies. Scaling at the encoder saves nothing, and
  decoding originals for a file nobody will grade wastes the minutes the setting exists to save. A
  final export still reads originals — one that quietly delivered proxies would be a serious failure.
- Downscaling constrains the **short edge**, never a fraction. Half of 4K is still 1080p, half of 720p
  is a thumbnail, and a width-based rule mistreats portrait footage.
- Both dimensions must come back **even**: yuv420p subsamples chroma by two, so an odd dimension is
  rejected or silently padded, and padding shifts the picture half a pixel against the preview.
- A flag is interpreted in **one** place, so the dialog's estimate and the renderer cannot disagree
  about what it means.

- Fixing one side of a preview/export divergence **creates the other side**. The export was wired to the
  shared effect registry while the preview kept building its own, turning "drawn nowhere" into "drawn in
  the file but not on screen". Change both in one commit or neither.
- The shared trio is registry, compositor and texture provider. Anything a third one of those appears,
  it is a divergence waiting to be found.

- Preview and export share **one effect registry**, not one compositor and two registries. The export
  built its own from the builtins, so a project-local effect rendered in the preview and vanished from
  the delivered file. Anything the preview merges in, the export must be handed.
- Adding a source of content to the preview means adding it to the export in the same change.
  Project-local effects were built for one and not the other, and the gap survived several rounds
  because every individual piece worked.

- The delivered file carries the **sound**. The encoder was sent an audio codec and a bitrate and never
  an audio stream, so every export was silent — an interface (`OfflineMixRenderer`) declared for the
  job and never implemented. A codec setting is not an audio path.
- The mix is rendered from the **same `MixPlan`** playback schedules. WYSIWYG is not only about pixels:
  a separately-written mix diverges exactly where nobody checks — a solo, an eased fade.
- Offline, not recorded. `OfflineAudioContext` is deterministic and faster than real time; capturing
  playback takes as long as the sequence and folds in whatever the device did.
- 16-bit conversion is **asymmetric on purpose**: two's complement runs to −32768, so scaling both
  directions by 32768 turns a full-scale peak into its own inverse — the loudest possible click, exactly
  where the music was loudest.
- Checking that a stream *exists* is not checking it carries anything. Read the level; digital silence
  is about −91 dB.
- Drive the **whole loop**, not its parts. Generate → accept → export found this; every individual step
  had been tested and passed.

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

- A value the plan computes and no renderer reads is not a feature. `reveal` was evaluated per frame,
  the advances were measured and dropped, and `typewriterAt` — the whole cut arithmetic, fully tested —
  had no callers. Three built parts, nothing joining them, and every title silently fully typed.
- The typewriter cut is **three regions**, not per-line rectangles: reading order guarantees that some
  lines are done, exactly one is mid-word, and the rest have not started. That holds for any line
  count in three numbers; a list would need a bound the shader cannot exceed.
- The cut belongs in the **seed copy** that starts a layer's effect chain — free, because that copy
  happens anyway, and correct, because a glow must light the characters that exist rather than the
  whole line with holes cut out of its halo afterwards.
- Advances are in the raster's own pixels and the texture is frame-sized, so the **placement has to be
  kept**, not only applied. Without it a centred title cuts half a frame from its own text.
- A type that is the seam between two packages belongs in `core`, expressed in the units that cross
  it. Texture coordinates cross; glyphs do not.

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

### Verification harnesses (six of them now)

**A harness window does not take the screen.** Three shells per `smokecheck` run, several runs an
hour, is a window repeatedly stealing focus from whoever is using the machine — which is a real cost
of checking the assembled application, and one worth paying down rather than living with.

`NOS_HEADLESS=1` — which every harness sets, and `NOS_WATCH=1` overrides when a run has to be seen —
shows the window with `showInactive` at `(-10000, -10000)`: painted, laid out, answering CDP, and
nowhere near the desktop.

**Not hidden**, and that was the first attempt: `show: false` fails because a window that is never
mapped never lays out, so every element reads as invisible and the harness times out clicking things
that are plainly there. The window has to be *real* for the checks to mean anything — this is the same
application with its frame somewhere else, not a mode that could pass for reasons a user would never
have.


Two of them drive the whole application. `apps/desktop/exportcheck` launches the shell, lets it reopen
a fixture project, exports, and reads the delivered mp4 back with ffmpeg — it exists because the export
dropping every title was invisible to every unit test, each side being correct alone and only the seam
wrong. `apps/desktop/perfcheck` writes a **200-clip** project, zooms out until all of it is on screen,
and drags a clip for sixty frames while watching the main thread. It covers the half of §8 nothing
measured: `@nos/smoke` guards the document and the plan builders, but what a user feels is React
rendering two hundred clips under a moving pointer.

`apps/desktop/smokecheck` asks the plainest question of all — does the editor open, does a project
load, does every panel draw — and treats every renderer error as fatal, including the ones that leave
the screen looking fine. It is shallow and wide on purpose: depth belongs to the harness that owns the
capability, and this is the coverage no unit test gives, because a unit test renders a component with
the props it chose rather than the ones the shell passes.

**The state a new user meets first was covered by nobody.** Every harness writes a session file and
opens a project, so the no-project path had never been exercised. Smokecheck gives it its own shell —
the application has no way to close a project, and inventing one purely to be testable would be the
tail wagging the dog — and checks that it says so, offers the way in, and does not hold out actions
that cannot work.

**A notice that names a problem it can solve should offer to solve it.** Missing media was announced
in the status bar while the repair lived only in a clip's context menu.

**A status about the system belongs outside the empty state.** The backend's state rendered only in
the branch that draws a generator, so a project holding no manifests never learned its backend was
unreachable. Chasing a failing check found it; printing what the panel actually said found it, not a
guess.

**Drive the control, not the bridge.** A check that writes a setting through the IPC bypasses the
renderer's own state, so nothing downstream reacts — which looks exactly like a feature that does not
work.

**A check that cannot run must say so, not pass.** The first version of the missing-media check found
nothing missing — smokecheck synthesizes the fixture's audio — and printed that rather than passing
quietly, which is the only reason the gap was visible. It now makes the file go while the editor runs,
which is the shape of the real thing and covers the watcher, the recompute and the notice at once.

**Recovered work is unsaved work.** Restoring a recovery resets the store, and a reset marks the
document saved — so the editor believed unwritten work was on disk: no autosave, no marker, no prompt
on close, and the rescued work lost by the next quit. A reset now says whether the document is what is
on disk, defaulting to yes because the usual reset is an open.

**Ask whether a new guard can misfire, in both directions.** A prompt on every close would be worse
than none; a prompt that never fires when it matters is worse still. Checking the first found the
second.

**State the shell needs at close time is pushed, not pulled.** Asking the renderer whether it is dirty
*while* the window tears down races the teardown, and a stale answer is either a lost edit or a prompt
nobody can explain. The same reasoning puts the close after the save, in the renderer: an editor that
saved while quitting would be a data-loss bug wearing the costume of a fix.

**A modal in the shutdown path can hang every harness.** They tear down by killing the process, so a
dialog that appeared on a graceful close would wait forever — worth re-running all three after touching
anything on that path, and perfcheck especially, since it leaves its document dirty.

**Crash recovery is driven by killing the shell**, not by closing it: a polite close exercises the
path that was never in doubt. Two assertions, because they fail for different reasons — the recovery
file appears after an edit, and the next launch offers the work back. Checking only the second reports
"recovery is broken" when the thirty-second autosave has simply not run yet, which is what a six-second
wait did.

**Print as you go, not in a `finally`.** Two throwaway probes were lost to this: a process killed
before the end printed nothing at all, and the absence looked like a broken feature rather than a
broken probe. The harnesses print incrementally, which is why they survive — and is a reason to put a
check in one rather than in a script.

**An escape throws where an unreadable file is skipped**, and the difference is deliberate: a file
that will not read is ordinary and should be survived, while a path pointing out of the project is a
programming error and should be loud.

**A binding that does nothing looks exactly like one that was never added**, which makes it the
easiest regression to ship and the hardest to notice. The transport keys are checked against the
playhead's own readout, which names the current time in its accessible label.

**A harness's own first failures are usually its own.** Smokecheck's were: it copied a fixture without
synthesizing the tone made at runtime, and it looked for the status bar as a `region` when a `<footer>`
is `contentinfo`. Check the harness before filing a defect — and take the failures as proof the checks
can fail, which is worth having.

**A fixture that lies makes the number mean something else.** Perfcheck's two hundred clips pointed at
`media/absent.mp4`, which was never created — harmless until the editor learned to notice missing
media, after which every clip was offline and each drew a marker. That is the whole of the ~12.5 → ~15
ms drift, and why three sensible memoization fixes moved nothing: the drawing *was* the work. The
fixture now makes a second of black and a second of silence, and measures 13.3–13.6 ms.

**The offline marker itself costs ~2 ms of the 16 at 200 offline clips**, by A/B against a build with
the check disabled. Bounded, inside budget, and only where the media has genuinely gone.

**Measured, so it does not have to be argued about again:** a pointer move costs ~12 ms of the 16 ms
budget at 200 clips fully zoomed out, with **zero long tasks**. The timeline meets §8.

Two lessons from getting there, both about the measurement rather than the code:

- **Frame intervals measure the display, not the application.** A p95 of 17 ms read as a budget breach
  until the idle frame turned out to be 8 ms — the screen runs at ~123 Hz, so 17 ms was two ordinary
  frames. Assert on long tasks and on cost per interaction; never on rAF gaps, and never against the
  refresh rate, which would make the same code pass on one machine and fail on another.
- **Memoizing `ClipBody` is a pessimization.** Skipping the 199 clips that do not move sounds obviously
  right and measures ~5% *slower*, because every clip's `geometry` is recomputed each render and the
  props genuinely differ, so the comparison never skips and only adds work. Do not try it again without
  first making the drag preview preserve clip identity — and without a number showing it helps.

Each covers a property that cannot be checked in Vitest, and each exits non-zero
so it can gate a release:

| What                    | Serve                                             | Run                                       |
| ----------------------- | ------------------------------------------------- | ----------------------------------------- |
| Compositor pixels (17)  | `cd packages/compositor && npm run glcheck:serve` | `npm run glcheck`                         |
| Text rasterizer (19)    | `cd packages/text && npx vite --port 5201`        | `node packages/text/rastercheck/run.mjs`  |
| UI layout (screenshots) | `cd packages/ui && npx vite`                      | Playwright screenshot, compare to mockups |
| Timeline at 200 clips   | none — writes its own project                     | `node apps/desktop/perfcheck/run.mjs`     |

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

- The project's `effects/` folder is **loaded**, not just created. §4 reserves it and §7
  asks that no concrete effect be baked in; for a long time the folder existed and
  nothing read it, so the extension point was theoretical.
- A library that reads a folder has **two** kinds of failure and both must be visible: a
  file that never reached the registry (unreadable, not JSON) has no entry to disable, so
  it needs its own line; one the registry rejected is listed disabled with its reason.
  Showing only the second is how a malformed manifest gets skipped in silence.
- Project effects are registered **after** the builtins, so a project replaces one by
  declaring the same id rather than having to pick a different name.
- A library that reads the project folder must depend on the **open project**, not load
  once on mount: no project is open at mount, `listFolder` correctly answers empty, and
  the folder is then never read again. It also has to reload on change, or one project's
  effects survive into the next.

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

- A **track**'s level is a plain number; a **clip**'s is an `AnimatableNumber`. A track is
  the constant its clips are heard through, so the panel must not offer to keyframe one —
  a control for something the document cannot store is worse than no control.
- Faders **clamp**, they do not refuse. The useful behaviour at the end of the travel is
  to stop, and a rejection there is a dialog in the middle of a drag. A non-finite value
  floors: `Number('')` is 0, and a cleared field must not quietly become silence.
- A **scrub restarts the meter's tail**, and the tail's silence check is held off for
  the length of a grain. The tail is 1500 ms against an 80 ms grain so length was never
  the problem — but a grain starts a millisecond after `scrub` returns and ramps up over
  five more, so the first read is legitimately silent and ending on it stops the loop
  before the sound arrives. This is also the only way to observe that scrub audio works
  at all: there is no output device in a harness, and the meter is the seam.
- Scrub audio plays **only when the transport is parked**. The engine stops playback to
  make room for a grain, which is right at rest and wrong mid-playback: a click on the
  ruler should move the play position, not replace the sound with a blip.
- A clip's level and its track's belong beside each other. A level is read *against*
  something, and "this clip is at −3, what is the track doing to it?" is unanswerable
  with the two numbers a metre apart.

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

- An icon earns its place by doing work a word does badly: alignment has a universal glyph and three
  mutually exclusive options, so it is three toggles rather than a dropdown. Decoration is not the
  point — issue #21 calls the views raw, and the fix is legibility, not ornament.
- Heading glyphs are **muted, never coloured**. A landmark is not a status, and colour in this
  application already means something specific.
- Replacing a working control with a different primitive is exactly where a value stops being
  committed. Drive the new one and read the file, not the pressed state.

- A change to something that carries several fields takes a **change object**, not a
  whole value: `undefined` means leave it, `null` means clear it. `updateMarker(…, {
  label })` must not wipe a colour it never thought about, and clearing removes the
  field rather than storing a `null` that `project.json` reads back as a value.
- A marker's single click **seeks** — that is what a place is for. Editing it is behind
  a double-click, because the flag is eight pixels wide and the cheap action has to
  stay cheap.

- Track order **is** layer order: the compositor walks video tracks in reverse so a later
  one draws on top. Anything that reorders them is changing what the picture shows, not
  the layout.
- A track moves only **within its own kind**. The timeline reads video, then audio, then
  text, and a move across that boundary breaks the reading for the life of the project —
  so it is refused, and the control is disabled rather than silently doing nothing.
- A track's drawn height comes from `laneHeight`, never from `track.height` directly.
  Five things need the answer — header, lane, clips, and the two running offsets for
  the playhead and the drop indicator — and one of them disagreeing puts every row
  below it at the wrong y.
- **Collapsing is a view state**, so it is a track flag beside mute and solo, not an
  edit. The height is kept and restored, the clips stay drawn as bars, and a locked
  track collapses like any other: collapsing disturbs nothing on it.
- Header widths are **measured, not guessed**. At 147 px a side-by-side header spent
  everything on padding, four toggles and one gap, leaving 15 px for the name — about
  one character. It is 44 wide for that reason, the disclosure takes the kind icon's
  place where there is no room for both, and a collapsed row drops the toggles.

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

### Theme rules (keep these)

Issue #21's remaining half — "lehet majd több theme is" — is closed. Six palettes: the one the editor
was built in, read back out of the stylesheet `npx shadcn init` wrote, and shadcn's five base colours
from its own registry. **No colour here was chosen by eye**, and each theme records the URL it came
from, because the request was for shadcn's theming and a palette invented to look shadcn-ish is the
one thing that could not be called that.

**A theme is data.** Append to `THEMES` and it is offered by the picker, emitted into the stylesheet
and measured by the audit, with nothing else written. `ThemePalette` names all thirty-one roles and
none is optional: a theme that forgets one is not a theme with a gap, it is a theme under which one
control silently keeps the previous palette's colour.

**Colour only — geometry is not a theme.** `--radius` is left out although shadcn's registry carries
it beside the colours. Squared corners are this application's shape; a palette that also reshaped every
control would be a different application. It is also what makes switching safe mid-edit: nothing moves,
nothing reflows, a timeline measured in pixels stays where it was.

**Applied as CSS, pinned to the data.** The blocks are written into `globals.css` between markers, so
nothing flashes a frame late and the cascade is the browser's. Two copies of anything drift, so
`theme-css.test.ts` rebuilds the region from `THEMES` and fails if the file differs. `:root` and
`.dark` are left exactly as shadcn wrote them, which is why a build that never sets the attribute
renders precisely what it rendered before.

**Contrast is measured, not admired.** A palette is thirty-one strings and reading them tells you
nothing about whether text on a surface can be read. `auditTheme` converts to sRGB and holds every
text pair to WCAG in both appearances — and it is a *function*, so `theme-audit.test.ts` can point it
at deliberately broken palettes and prove each fault it claims to find. A check nobody has watched
fail is not a check.

**Distinctness is a different question from contrast, and conflating them is a bug I made.** WCAG's
ratio is a function of luminance alone, so shadcn's orange `chart-1` and teal `chart-2` — equally
bright, wholly different — score 1.02:1. Measured that way every colourful ramp shadcn publishes looks
broken. Categories are compared by OKLab distance instead.

**Two things this measurement found, both real and neither new:**

- The colour conversion linearized twice. `oklchToSrgb` returned the matrix's *linear* output and
  `relativeLuminance` linearized it again, so every dark colour scored far darker than it is. A
  conversion wrong by a gamma curve returns a plausible colour for every input; only a number from an
  outside source catches it — here, that `oklch(0.5 0 0)` is `#636363`.
- **`chart-*` was drawn as text in a dozen places and it is not a text palette.** Measured against the
  surface it sits on it runs from 10.5:1 down to **1.42:1** across the six palettes, and in the
  application's default dark appearance the variant picker's seed sat at 2.90:1 — below AA before any
  theme was added. The timeline had already found this once and written it down: "those roles are
  chosen to be legible as a fill behind something, and `chart-1` on a light background is barely
  there." Now fixed everywhere: colour on the glyph, words at full contrast.

**The rule is mechanical, so it is checked mechanically.** `chart-tone.test.ts` scans every `.tsx` in
`packages/ui` and `apps/desktop` and fails a `text-chart-*` that sits on anything but a self-closing
element — an icon has no words of its own; a container will hold some. A tone written as a *value*
(`glyphs.ts` per asset type, the timeline per track kind) is not a paint and is not matched, and
`bg-chart-*` / `border-chart-*` are left alone because a fill is what these roles are for. Verified by
putting one back.

**Never revert a mutant with `git checkout` on a file holding uncommitted work.** Doing so here
discarded the whole setting the mutant was testing, not just the mutant. Copy the file aside first, or
commit before mutating.

### UI rules (keep these)

- Filtering the project folder **opens every folder**, and restores the user's own
  expansion state when the box empties. A match behind a collapsed folder reads as a
  search that does not work.
- A filter matches the **path**, not the name. A folder name is how a user says "in
  here", and matching names alone answered "audio in `generated/`" with nothing,
  because no file there is called `generated`.
- A filtered folder's size and count are **recomputed**. `generated/` reading 47.9 MB
  above the one file that matched contradicts the screen.
- Offer only filters that can match something. A `text` or `mask` kind would always
  return nothing in a project folder, and a control that never works teaches the user
  that none of them do.

- Write a control's name **once**. A visible label plus an `sr-only` copy inside the
  wrapping label names the control correctly and puts the word in the document twice, so
  "find the control called X" becomes ambiguous — which is how the duplication announces
  itself. Where the layout allows it, the wrapping label carries the visible name.
- A shortcut is declared **once**, in `apps/desktop/src/renderer/shortcuts.ts`, and every
  surface that shows one reads it from there. Menus used to repeat the chords, so a
  rebinding had two places to change and the menu was the one that kept printing the
  old one.
- Every catalogue entry must be read off the handler that implements it. A reference
  sheet is believed: one listing a chord nothing listens for is worse than no sheet,
  because the user presses it, nothing happens, and they stop trusting the rest.
- `conflictingShortcuts` guards the property worth guarding — two actions on one chord
  means one silently stops working, decided by listener order, and it surfaces months
  later as "that shortcut does nothing".
- A gesture is a shortcut. `Alt`-drag is the only way to reach the spec's *csúsztatás*
  and has no on-screen affordance, so a reference that listed only key chords would
  omit the single binding nobody can discover.

- A message that says something **worked** and one that says it did not want different
  lifetimes. A failure persists until resolved or dismissed; a confirmation answers an
  action and clears itself, or it becomes furniture under an error icon. Saying the same
  confirmation twice restarts its clock — two Keeps in a row say one sentence twice, and
  the second is the one being waited on.
- A rejection a user could answer must come with the answer. `insertGenerated` reports a
  collision so the user can decide; the status bar turns it into "Find room for it", and
  the retry is the same call with a different `placement` rather than a second path.
- Never use a media element's `controls`. Chromium's bar ignores the theme and matches
  nothing else on the panel. `TransportBar` draws it from the same primitives.
- The shadcn `Slider` spreads its props onto its **root**, and the control needing an
  accessible name is the range input inside the thumb. Wrap it in a `Label` with an
  sr-only string; an `aria-label` or an `id` on the root reaches nothing. This was wrong
  in three separate places before it was noticed — the transport, all five transform
  channels, and every effect parameter — because nothing asserted a name until a test
  tried to find a slider by one. Assert the name, not the presence.

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

`npm run check:gl` starts the GL harness's own server on a free port, runs the check and stops it.
The two-shell dance it replaces has a trap: served from the wrong directory the check still reaches a
page and reports **24 of 27 failing**, which reads as a compositor in ruins rather than a harness
pointed at the wrong application. Pairing them in code removes the chance rather than documenting it.

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

### Crossfade and fade rules (keep these)

Issue #38. The editor was hard to use for one structural reason: **an overlap was refused**. Every move
clamped flush against its neighbour, so the only route to a dissolve was a dialog asking for two clips
that already met exactly at a cut, an effect name, a length, and handles on both sides. The gesture
every editor uses — drag one clip onto the one before it — did nothing at all.

**Sound sums and picture occludes, and a crossfade means something different in each.** Two overlapping
sounds are both heard, so both ramp and the pair is equal-power: linear ramps put each side at half
amplitude at the join, which for uncorrelated material — two different takes always are — is about
−3 dB, an audible hole exactly where the join is meant to be inaudible. Two overlapping pictures are not
both seen: the later covers the earlier, so a dissolve is the incoming clip ramping *in* over an outgoing
one that stays whole, linearly. Fading the outgoing too would let the empty frame behind them show
through in the middle, which reads as a flash of black. That asymmetry is physics, not an inconsistency
to be papered over, and modelling it as one symmetric object would make one of the two wrong.

**A fade is a clip property, not keyframes.** A ramp written as automation is destroyed by the next curve
the user authors, cannot be recognized afterwards without pattern-matching a shape, and cannot be
removed without it. `ClipFade` sits on `ClipBase` because a ramp means the same thing in both domains and
only the quantity differs.

**The permission to overlap is narrow and named.** `moveClips` takes the clips a move may land on, and
everything else still refuses — an overlap touching two clips at once, or swallowing one whole, is a
collision as it always was. The timeline's rule that material is never displaced silently survives
everywhere else.

**Which clip is "incoming" is decided by which starts later, never by which the pointer is on.** Dropping
a clip just *before* a stationary one makes the moving clip the outgoing half. A permission list keyed on
`outgoing` therefore named a clip that was moving anyway, and every leftward dissolve was refused as a
collision — while the rightward case passed its test.

**The ramp is written for where the clips landed, not where they were asked to go.** A group meeting frame
zero is clamped by its earliest member, so the predicted overlap and the real one differ.

**The compositor sorts a track's live clips by start.** Two clips can be live at one frame — that is what
an overlap is — and insertion order decided which was on top, so the same overlap dissolved one way in a
fresh project and the other way after a reload.

**Trimming reaches everything linked, and snaps.** Cutting the head off an imported video moved only the
clip under the pointer, so the picture got shorter and its own sound did not — a success that half
happened, which is worse than a refusal because nothing on screen says anything went wrong. And trimming
was the one gesture that did not snap, which is how a single black frame survives between two clips that
look adjacent at any working zoom.

**A group trim travels as far as it can rather than refusing.** `reachableTrimDelta` binary-searches the
limit *through the operation itself*, because "how far can this go" is the composition of every check the
two trims perform — collisions, source handles, locks, emptiness — and restating them is how a limit and
its operation drift apart.

### Keyframe rules (keep these)

Issue #37, and its first two symptoms were one cause. The lanes were injected into the clip column as an
opaque `ReactNode`, so the header column beside them had nothing to put in the same space: creating a
keyframe made a lane appear with no name against it *and* pushed every row below out of step with its own
header.

**A lane is a row of the timeline.** `TimelineLaneRow` carries an id, a label and a height, and the header
column and the clip column each draw from the same number. Alignment between two columns cannot be
maintained by two components that each decide it. The hint line under the lanes is a row for the same
reason: anything down there that is not a row has nothing opposite it.

**Markers sit at their own value.** A lane that drew every marker on one baseline said nothing about the
shape of the animation, which is the thing a curve exists to show. The curve between them is sampled
through `evaluateAt` — the function the compositor and the mixer call — so it cannot flatter a shape the
picture does not have.

**A drag writes both axes in one edit.** Two edits per pointer move would be two history entries once the
gesture commits, and the second would be applied to a document the first had already re-sorted.

**`bezier` is a sixth easing with four numbers beside it, and it is outside the badge's cycle.** A preset
list can never hold the curve someone actually wants, so the curve is the control — nobody knows what
`0.42, 0, 0.58, 1` looks like. Landing on it by clicking a badge would put the user in a mode whose
controls are elsewhere, on a first curve indistinguishable from linear.

**Time is clamped, value is not.** A control point outside the segment makes the curve non-monotonic in
time, so the value would run backwards, which no evaluator here can express. Overshoot past the endpoint
*is* a legitimate curve and is one of the two reasons to want a custom one.

**The solver falls back to bisection where Newton stalls**, which is exactly `cubic-bezier(1, 0, 0, 1)` —
the hardest ease a user can ask for, and the one where a naive solver silently returns its last guess.

**The vertical zoom is the lane's height, per lane.** On 34 pixels a value of 0.51 and one of 0.55 are the
same pixel however carefully the marker is dragged. Per lane because a user magnifies the *one* curve they
are shaping; growing every lane at once would push the tracks below off the screen. Not in the document —
it is how closely someone is looking right now, not a property of the animation.

**A marker's settings belong in the right column too.** A marker is eleven pixels wide and the lane can
only afford a value field and an easing badge; everything else about it had nowhere to be. The frame is
shown as a *timeline* position, because keyframes are stored clip-relative and every other number in that
column is absolute.

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

- 2026-08-09: Issues #38 and #37 — the editor's two worst surfaces.

  **#38, the crossfade.** Three separate faults reported as one experience. Trimming a linked pair moved
  only the half under the pointer. Trimming was the one gesture that did not snap, so two clips could not
  be landed flush and a single black frame survived between them. And an overlap was refused outright, so
  the gesture every editor uses to make a dissolve did nothing.

  `trimGroup` and `snapEdgeDelta` close the first two. `ClipFade`, `crossfadeForPlacement`,
  `applyCrossfade` and `moveWithCrossfades` close the third, with the rules above. The fade is drawn as a
  wedge and dragged from a grip at each top corner — a control that appears only once the thing it
  controls exists can be found only by someone who already knows it is there, which is what "making a
  crossfade is bloody hard" costs.

  One bug found by writing the mirror of a passing test: dropping a clip just *before* a stationary one
  makes the **moving** clip the outgoing half, so a permission list keyed on `outgoing` named a clip that
  was moving anyway and refused every leftward dissolve.

  **#37, the keyframes.** The lane had no header, so a new lane named nothing and knocked the two columns
  out of alignment; markers sat on a shared baseline, so the curve was invisible and its shape
  unadjustable except through a number field; and clicking a marker put nothing in the right column.

  `TimelineLaneRow`, markers placed at their value, the sampled curve, a two-axis drag, `bezier` with a
  draggable editor, a per-lane vertical zoom, and `KeyframeInspector`.

  3652 tests green; `tsc --build` clean.

- 2026-08-09: What the harnesses found once the features were in.

  Three of the four came from the *checks* being wrong in ways that looked like the application being
  wrong, which is the failure mode a harness has to be watched for as carefully as the code.

  **The completion check lied for two rounds.** It reported the editor broken while the engine answered
  correctly throughout: Monaco auto-closes the `{` the harness inserts and re-indents what follows, so
  the buffer is four lines rather than three, and a caret counted up from the end landed inside the
  trailing brace where there is genuinely nothing to suggest. Counting down from the top is exact
  whatever the editor adds below. The list is also named `Suggest`. And `readCode` compared rendered
  text against a literal — Monaco renders significant spaces as U+00A0, so every completion that ends
  in a space failed, which is all of them.

  What settled it was dumping the widget's own class from the running window: `suggest-widget message
  visible` with "No suggestions." is a provider that was **asked and had nothing to say**, which is a
  different fault from a widget that never opened.

  **The perf check measured the monitor.** Each pointer move waits on a frame, so the wall clock per
  move is the application's work plus one frame of this display — and the assertion charged the
  application for both. The same build read 12.9 ms on a 131 Hz run and 14.8 ms on a 101 Hz one. Two
  hours went into hunting a regression that was a refresh rate. `frameMs` was already measured for
  exactly this and never used; subtracting it leaves **6.1–6.6 ms**, stable across runs, against the
  spec's 16 ms.

  **One real regression, found on the way.** Allowing a single-clip drag to overlap meant routing every
  drag through the many-clip operation, whose collision scan compared every pair on the track —
  quadratic, unnoticed for as long as only a multi-clip drag reached it. 0.53 ms → 0.056 ms for one
  move on a 400-clip track. The guard beside it asserts the **slope**, not a time, and was run against
  the quadratic version before being trusted: its first draft wrote `Math.max(smallMs * 2.6, 1)` and
  the floor swallowed the whole signal.

  **And one real bug, found by the harness doing its job.** The keyboard nudge went through the
  single-clip move, so a clip already crossfaded with its neighbour could not be nudged at all — every
  arrow press was a collision with the very clip it had just been joined to — while dragging the same
  clip worked. A keyboard that refuses what the pointer allows is two behaviours for one edit.

  Verified in the running window: the fade reaches the clip and `project.json`; **dropping a clip onto
  its neighbour makes a crossfade, both sides ramped**, and it survives the save; a lane names its
  parameter and is measured to the same height as its header; magnifying makes it taller; the curve
  draws; a marker opens in the right column and `bezier` gives it an editor.

- 2026-08-10: The dissolve, read as pixels — and a harness eating its own programs.

  Nothing in the repository said what a crossfade *looks* like. The fade model, the plan and the
  compositing order are each unit-tested, and none of them can catch two clips at the right opacities
  composited in the wrong order: a plausible plan and a wrong picture. The GL check now builds a real
  document with a twenty-frame overlap, plans it through `buildRenderPlan` — not from hand-written
  render items, because the ordering rule being checked lives in the plan builder — and reads the
  frame back. Halfway through, (128, 0, 128) on a real driver: half of each shot, and the two channels
  summing to a whole one is what says the picture never went dark in the middle.

  It failed for an hour against a correct dissolve. The mask scenario built a second compositor from
  the **same** programs, builtins and pool and then disposed it, which disposed those — so every
  scenario written after that point rendered through a program that no longer existed. The failure is
  silent: uniforms stop being set and the draw comes out unblended, reading as a compositing bug in
  whatever was added last. What finally settled it was that the *control* — a hand-written layer at
  half opacity, the same shape as a check that passes earlier in the same run — was equally wrong.

  **When a new check fails, run its control.** If the control fails too, the fault is in the harness
  or in the state it inherited, not in the thing being tested. Both of this round's long hunts — this
  and the perf check measuring the monitor — would have been minutes rather than hours with that
  question asked first.

  Also this round: `setGroupFade`, so a picture and the sound split out of it ramp together — the same
  rule the linked trim follows, and more obvious when broken because you can hear it. `G` closes the
  gap before the selection. And two exports nothing reached (`hasGapBefore`, `clearClipFade`) were
  removed by the project's own sweep, which is the shape every gap in this codebase has had.

- 2026-08-10: A locked track that protected nothing in two panels.

  Found by the sweep this file already recommends — **count how many times a function name is
  defined**. Three hand-rolled copies of "write this clip back into the document" existed, in the
  keyframe lanes, the text inspector and the speed section, while `updateClip` — which does it
  properly — had no caller outside its own package. That combination is the whole story: the helper
  nobody used was the only one that was right.

  Each copy was missing something, and both omissions are invisible until someone looks for them.

  They **rebuilt every track**, so one keyframe edit copied all three tracks and every clip array on
  them. The rule is that only the changed root-to-leaf path is rebuilt and untouched tracks stay by
  reference, which is what makes snapshot undo cost pointers rather than a copy of the project. A test
  asserts it for a split; nothing asserted it for a keyframe, and it was not true there.

  And neither **checked the lock**. Locking a track stopped every gesture on the timeline and none of
  the ones in a keyframe lane or the text panel — markers still dragged, the value field still wrote,
  the font still changed. A lock that stops a drag and not a number field is a lock nobody can rely
  on.

  Two sweeps were run alongside it and came back clean, which is worth recording so they are not
  repeated blind: no document field lacks a writer outside the serializer, and the remaining duplicate
  names are test fixtures and same-name-different-domain helpers (`clamp` over a range and `clamp` over
  a clip duration).

  Also this round: the delivered file is asked whether the fade *happened* — two windows of the same
  tone, −37.2 dB rising to −24.1 dB — because the mixer has exactly the seam that once hid every title
  from every export, and a ramp that plays and does not export is invisible to every unit test here.

- 2026-08-10: Undo, where every edit can reach it.

  §6.1 asks for undo and redo on *everything*. The only visible pair sat inside the clip actions — on
  one tab, and only while a clip was selected — so the control for taking back a mistake disappeared
  exactly when the mistake was made somewhere other than a clip: a track deleted, a project setting
  changed, a manifest saved. The keyboard worked throughout, which is what kept it invisible.
  **Everyone who tests this application knows the chord, and that is why nobody noticed.**

  They are in the title bar now — the workspace-tab rule puts the editor's own actions there, and a
  control that moves depending on which tab is open is one you look for rather than reach for.

  And they **say what they will take back**. Every commit here already carries a label; the store has
  recorded one since M1 and `StoreSnapshot` has exposed `undoLabel` and `redoLabel` just as long, and
  nothing had ever read them. "Undo" is a promise with no content; "Undo close the gap" is one you can
  act on. This is the same shape as every other gap this ledger records — a field with no reader —
  and it was found the same way.

- 2026-08-10: A fade that follows a curve you choose.

  A ramp had one shape per domain and no way to ask for another, and editors care about fade curves —
  a logarithmic fade-out and a linear one are audibly different things.

  It reuses `Easing` rather than growing a fade-shaped vocabulary of its own. **A ramp and a keyframe
  segment are the same question** — how does a value get from one place to another over a span — and
  two answers would mean two evaluators, two serializations and two editors, of which the second would
  be the one missing `bezier`. As it is, the curve editor built for keyframes edits a fade curve with
  no new code.

  **Absence stays meaningful.** No shape means *each renderer's own* default, and they differ: equal
  power for sound, linear for picture. So the control offers `default` as a first-class choice rather
  than naming it `linear`, which would be a lie on the audio side. A chosen curve *replaces* the
  default rather than compounding with it — asking for `linear` has to give a linear ramp, and a sine
  applied on top would give something that is neither.

  `FadeChange` reads its curve with `in` rather than `??`, because mentioning a key and omitting it are
  different gestures: omitted leaves the curve alone, mentioned-as-undefined clears it. Under
  `exactOptionalPropertyTypes` there is no other way to say "set this back to absent", and without the
  distinction the `default` button could not be pressed — its value *is* absence. Worth remembering the
  next time an optional field grows a control.

- 2026-08-10: Two ways of watching a harness that both lie.

  Worth writing down because each cost real time tonight and neither is about the application.

  **`pgrep -f "smokecheck/run.mjs"` matches the shell that is polling for it.** A wait loop written
  that way never ends: it finds its own command line, reports the harness as still running, and does so
  for as long as you leave it. Several of those accumulated, each insisting a run was in flight after it
  had died. Wait on a **marker written by the run itself** — a last line, a file — not on a process
  whose name your own command contains.

  **`npm run verify` builds `apps/desktop`.** `tsconfig.build.json` references it, so running verify
  while the smoke harness is up rewrites the main bundle underneath it. Nothing observably broke, but a
  run overlapped by a build is not evidence, and calling it evidence is the mistake. One thing touches
  the tree at a time.

  Also this round: the bezier editor committed on **every pointer move**, so a drag across the curve box
  buried whatever came before it under an entry per move. Its `onCommit` seam existed and neither caller
  used it — the same shape as every other gap here, found this time in code three hours old. `onCommit`
  is required now and `onChange` optional, which makes the cheap wiring the correct one.

- 2026-08-10: The other half of the crossfade.

  Dropping a clip onto its neighbour makes the sequence **shorter** by the overlap. That is right when
  you are closing up a cut and wrong when the cut is already timed, and every editor offers both. The
  second one grows each clip into the material already beyond its edge, so the timing downstream is
  untouched.

  It is `addTransition`'s mechanic, and why that is not simply reused is the point: **transitions live
  on video tracks**. A pair of sounds meeting at a cut had no way at all to be crossfaded except by
  dragging one over the other and shortening the sequence — which is #38's complaint, stated about
  audio.

  **Handles are the whole difficulty**, and the refusal is whole rather than one-sided: a crossfade
  with one side extended is a clip that has silently grown, and the user asked for a dissolve rather
  than for more material. `maxCrossfadeAtCut` exists so a caller can offer a *shorter* fade instead of
  only a refusal — "there is not enough material" is true and unhelpful next to "six frames is all this
  cut has". The menu row and the keyboard both recompute it from that one function, because two
  derivations of "what can this cut carry" in different files is exactly the shape this codebase's
  drifts take.

  `Shift+F`, not `F`: bare `F` fits the sequence to the window and is a binding people use constantly.

- 2026-08-10: Two more of the same shape, both in code written hours earlier.

  The pattern this ledger keeps recording is a seam that exists and nothing uses. It is worth noting
  that **new** code produces it just as readily as old code — neither of these was inherited.

  **A still went to source frame −10.** `handleBefore` answers infinity for an image and a title,
  correctly: a frame held longer is what the viewer sees either way. What that must not license is
  moving a source position they do not have, and a crossfade at a cut did. That is the kind of wrong
  number whose symptom appears three layers from the edit that caused it, because every reader
  downstream clamps or rounds a negative source frame differently.

  **`side` was reachable and its behaviour was not.** Every caller passed the default, so selecting the
  *second* clip of a pair and asking for a crossfade did nothing at all, with no reason given — which
  reads as a broken command rather than as a preference about sides. `crossfadeSideFor` is now the one
  derivation the row, the menu action and the keyboard all read.

  And one more harness lie: the smoke check pressed `Ctrl+D` with focus still in the `source in` field
  it had just committed. Every shortcut in this shell ignores keys while a text field has focus —
  deliberately, because a `d` typed into a name is a `d` — so the duplicate never happened and the
  check reported a broken command rather than a harness typing into a box. **After committing a field,
  put focus back where the gesture belongs.**

  The crossfade-at-cut row had also only ever been checked in its *disabled* state, because the
  fixture's tone starts at source frame zero and has no handle to fade through. A check written against
  that can confirm nothing but the refusal. The harness slips the clip six frames in first, through the
  control a user would use, and then drives the edit: offered 12 frames, made a 12-frame overlap, both
  sides ramped.

- 2026-08-10: A dead end the drop gesture created, and a check that failed while passing.

  **Turning a dropped dissolve into a wipe was impossible.** Dropping one clip onto another leaves the
  pair *overlapping* rather than meeting at a cut, so the transition panel found no neighbour and
  `addTransition` refused as "not adjacent" — the user had to undo the drop and go back through the
  dialog, which is the dead end the drop gesture was added to remove. Closing it needed one rule first:

  **A transition governs the blend inside its own span.** Both mechanisms mix two pictures, and a clip
  can now carry a ramp *and* sit under a transition. Applying both blends twice — the incoming picture
  arriving at half opacity into a shader already mixing it in, which reads as a dip rather than a cut.
  The plan ignores the ramp there rather than the document dropping it: the same fade still governs the
  clip's other edge, and a transition removed later must leave it doing what it always did. **A rule
  the plan applies is reversible; a document edit is not.**

  An existing overlap then becomes the transition's span with neither edge moving. The geometry is the
  user's, already placed, and asking for a different length is asking to move a clip — which is not
  what naming an effect means.

  **And `exportcheck` reported red with every assertion green.** The shell is sent SIGTERM a line above
  the cleanup, and its renderers were still writing to `user-data` while the remove walked the tree, so
  it threw `ENOTEMPTY`. `smokecheck` already retried there. The fix existing in one harness and not its
  neighbour is the same shape as every other gap here — which is why the comment now names both.

  A check that falls over in its own teardown reports a green result as red. That is worse than not
  cleaning up, and it is worth saying out loud rather than letting the red line stand as evidence of
  something it was not.

  Also: **Fit frames the selection first**, then the marked range, then everything — three ways of
  saying "this bit", ordered rather than combined, because a union of them would frame a stretch the
  user never indicated.

- 2026-08-10: The blend rule, proved as a pixel.

  "A transition governs the blend inside its own span" was unit-tested at every layer and none of them
  could say what the frame looks like. `glcheck` now lays a transition over an overlap that already
  carries ramps on **both** clips and reads the picture either side of the wipe boundary.

  **A hard wipe is what makes the rule readable.** Either side of the boundary the shader picks one
  source whole, so "the ramp was ignored" and "the ramp was applied" are 255 and 128 rather than two
  shades of the same blend. Read off-centre deliberately: at progress 0.5 the centre pixel sits *on*
  the boundary, where either answer is defensible and neither is evidence.

  It ships with its **control** — the identical document with the transition taken away, which reads
  (64, 0, 128) at alpha 191: both ramps at half with the empty frame showing between them, which is
  the dip the rule prevents. Without that control a wipe silently failing to take over would be
  indistinguishable from one doing its job, because the check would pass on a document where the ramps
  had never mattered either way.

  Then run against the mutant, as everything here now is: inverting one condition in `withoutFade`
  drops both sides to 128 and fails exactly the two new checks, and the control still passes — which
  is what says the control is measuring the other thing rather than the same thing twice.

- 2026-08-10: Adding a menu row was unsafe, and the sweep that showed it.

  The reachability sweep came back clean — every operation `@nos/editing` exports has a caller outside
  it, and every field of `ClipFade`, `shape` and `shapeBezier` included, has a control. So the gap this
  time was not a missing feature but a **missing guarantee**.

  A context menu is two halves that have to agree: the rows that offer an action, and the code that
  runs one. `ActionMenuItem.id` was `string`, `MenuBinding.onChoose` took `string`, and the two were
  joined at the app by `action as ClipMenuAction`. The `switch` downstream ends in a `never` check —
  which looks like proof and is not, because the exhaustiveness it proves is over a union the value
  had merely been *asserted* into. **A new row with a mistyped id compiled, rendered, and threw when
  clicked** — the one moment nobody is watching a console.

  Both lists happened to be in sync. Nothing was keeping them there.

  `ActionMenuItem<Id>`, `MenuBinding<T, Id>` and `ActionMenuProps<Id>` now carry the caller's own
  vocabulary, defaulted to `string` so a menu not worth naming stays a one-line prop. A mistyped row is
  a build error *at the row*, with TypeScript suggesting the name that was meant.

  **The cast could not be deleted, only moved — so it moved somewhere it can be argued.** `MenuBinding`
  both produces ids and consumes them, so it is invariant in `Id`, and the panels that hold a menu are
  declared over `string` because they neither know nor care what the actions are. Making `Timeline`,
  `MediaBrowser` and `ClipBody` generic would remove the assertion entirely; it would also make three
  large components generic to state something none of them uses. `menuBinding()` crosses the gap in one
  named place where the property it depends on is true by construction: `ActionMenu` only ever reports
  an id it took from the list `items` returned. Written inline at two call sites, that property was
  restated unexamined at each, and a third menu would have restated it again.

  The other direction — a declared action no row ever offers — is a dead `switch` case rather than a
  crash, so it is a test rather than a type: three states between them reach every row, and each
  member of `CLIP_MENU_ACTIONS` must appear. Both guards were run against mutants. A mistyped id fails
  to compile; a row deleted from the list fails `offers link somewhere`.

- 2026-08-10: The lock protected three of six panels, and the sweep that found it had gone quiet.

  Counting how many times a function name is defined — the sweep this project's real bugs keep coming
  from — turned up `replaceClip` in three files and `withFade` in two. The interesting one was not on
  that list at all: **`replaceEffects` in `ClipInspector.tsx`**, a fourth hand-rolled copy of "write
  this clip back", found by widening the sweep to `tracks.map(` rather than to a name.

  It asked nobody about the **track lock**. So a track locked precisely to stop it changing could
  still have effects added, reordered and deleted, and their parameters edited, from the panel three
  feet to the right of the timeline that refused every gesture. Two more turned up beside it:

  - `KeyframeLanes.replaceParam` — the *effect* parameter lanes, three hundred lines below `mapClip`
    in the same file, missed when `mapClip` was fixed. On a locked track the opacity markers refused
    and the Film Grain markers beside them, drawn by the same component and looking identical, did not.
  - `AudioMix.replaceAudioChannel` — a locked audio track's clips could still be re-levelled and
    re-panned.

  **Why the earlier sweep stopped seeing them.** It looked for `updateClip` having *no caller*. Fixing
  two of the copies gave it callers, and the signal went quiet while three copies remained. **A check
  keyed on "is this used at all" cannot count how many places still do not use it** — which is the
  argument for the widened form, and for a test per panel rather than one for "the lanes".

  All three now go through `updateClip`, which is the single place that knows what a lock means. The
  inspector *says so* through `onReject`: silently discarding the edit would leave the user pressing a
  control that visibly does nothing, which reads as a broken button rather than as a locked track. The
  lanes stay silent deliberately — a marker that snaps back is its own feedback, and the document is
  what draws it.

  Each fix was run against its mutant: restore the hand-rolled version and the new test fails.

- 2026-08-10: The pass budget was computed and never shown, and three copies of the number that defines it.

  §8 asks for a warning above eight passes. `exceedsPassBudget` was written, tested, and **called by
  nothing** — the budget existed everywhere except on screen. The timeline badges a heavy *clip*, which
  is a different question with a different answer: three clips of four passes each earn no badge
  between them and still cost twelve passes on the frame being drawn. The frame is what §8 is about.

  It now sits beside the pass count it judges, as a warning and not an error: a heavy stack is a
  legitimate choice on a short clip. It names the number and the budget and stops — "12 passes, above
  the 8-pass budget" leaves the decision where it belongs, where "too many effects" would be an
  instruction.

  `PASS_WARNING_THRESHOLD` was written out **three times** — in the document module, in the compositor,
  and as a default parameter on the clip body. One definition now, so the badge on a clip and the
  warning on a frame cannot come to disagree about what the spec says from a one-line edit.

  **Four harness faults, all of which reported themselves as application faults.** The check drove the
  UI to build a heavy frame, and each attempt failed with a message about the wrong component:

  - `count()` is an immediate query with no auto-wait, so asking for the effect list on the line after
    the click that opens it reads the DOM one commit early. Reported as *the application has no Film
    Grain*.
  - The picker is a **toggle**, and an earlier section leaves it open, so the first click closed it.
    Reported the same way. A harness that assumes a control's state instead of reading it produces
    failures about the wrong component.
  - The fixture's video track is empty; at frame 0 the only layer is the title. Nine effects on "the
    first clip in the DOM" landed on something the frame does not show, and the strip went on reading
    `1 passes`. Reported as *a missing warning*.
  - Nine adds landed as one, and the pacing fix did not help — so the cause was never established.

  The last one is the lesson. **A setup with four ways to be wrong is not a check, it is a second
  program to debug** — and every one of its failures accused the code under test. The fixture states
  the condition now, and the window is asked only the question the check is about: does a frame over
  the budget say so. The nine-adds behaviour is left unexplained on purpose rather than written up as
  a finding: it was observed through a harness that was demonstrably wrong about three other things,
  and that is not evidence.

- 2026-08-10: The nine adds explained, and two functions that were traps.

  **The correction first.** Last entry left "nine adds landed as one" unexplained. It was the harness,
  and the cause is worth writing down because it will happen again: the effect stack's rows carry the
  accessible name `Film Grain, pass 1 of 1`, **Playwright matches `name` by substring**, and the stack
  renders *above* the picker. So after the first add, `getByRole('button', {name: 'Film Grain'}).first()`
  matched the stack row, and every later click merely selected the effect. Asked without a harness in
  the way — re-rendering the panel with each committed document, which is what the shell does — three
  adds append three effects with three distinct ids. The panel was never wrong.

  Both directions are now tests: fed back it appends, not fed back it replaces. The second is the
  failure mode named, so it cannot later be mistaken for a passing case.

  **`planValidUntil` deleted.** "Frame range a plan is valid for, so a preview can skip rebuilding
  while nothing changes" — written, tested, no caller. The comment is false: it returns the next clip
  *boundary*, and a plan is not reusable between boundaries because every layer names a source frame
  and every keyframed parameter is evaluated per frame. Wiring it up as its own docstring invites
  would hold the picture still and freeze animation.

  And the optimisation it exists for is worth nothing: **`buildRenderPlan` costs 0.009 ms per frame at
  200 clips**, against a 16 ms budget, next to a decode and a GL submit. Measured before deciding,
  because "this is a hot path" is a belief until someone times it.

  **`snapPoints` deleted** for the same reason with a sharper edge: `@nos/editing`'s
  `collectSnapCandidates` is the real one and offers markers, the work range, the playhead and the
  origin as well as clip edges. The core copy returned clip edges of a single track. It had no caller,
  and anyone wiring up the shorter one would have *silently lost* marker and work-range snapping —
  a feature disappearing with no error anywhere.

  **A dead function with a promise in its comment is worse than no function.** Both of these read as
  finished work waiting to be plugged in; both would have made the application worse. The sweep for
  "exported and never called" earns its keep by finding capability that is missing — and it finds this
  too, which is the same question asked of code rather than of features.

- 2026-08-10: Every empty folder was invisible in the browser, found while building something else.

  §4 defines a project **as** a folder structure and the browser as a view of the real tree.
  `walkProject` queued each folder for traversal and then dropped it — only files were ever pushed into
  the entry list — so the only directories the tree heard about were the ones it could infer from the
  paths of files *inside* them. **An empty folder did not exist as far as the browser was concerned.**

  A new project showed `project.json` and nothing else. No `media/` to import into, at exactly the
  moment a user is looking for somewhere to put footage; no `renders/`, no `notes/`, no `generated/`,
  until something happened to write into them. `buildTree` has always carried the branch for this —
  *"ensure empty directories still appear; an empty `renders/` is meaningful information"* — and
  nothing could reach it, because no directory entry was ever produced. **A guard written for a case
  that cannot arrive reads exactly like a guard that works.**

  Found while building the thing below, which could not be reached without it. That is the second time
  a feature has been the instrument rather than the point.

  **Clearing the derived cache**, per §4 — the one folder the spec calls disposable. The sidecar has
  served `/cache/stats` and `/cache/clear` since the media service was written, both covered by its own
  tests, and nothing in the application called either: a cache grown to a few gigabytes could be seen
  and not reclaimed, short of closing the editor and deleting the directory by hand with the shell
  still holding proxies open.

  Shaped like `prune-takes` beside it — one folder, disabled elsewhere rather than hidden, priced in
  the label, not `danger` — and with one deliberate difference: **no confirmation**. What goes is
  derived from sources that are still there and rebuilt the moment it is wanted, so the worst outcome
  is that the next preview waits for a proxy. An unused *take* is the only copy of something a
  generator produced, and removing one is a decision.

  Not automatic either. A cache that emptied itself on a size threshold would re-derive every proxy in
  the project at the least convenient moment, which is precisely when someone is working with large
  sources. It is offered, priced, and left to the person.

- 2026-08-10: What the empty-folder bug actually did to a new project, and the invariant behind it.

  Running the fix against its mutant in the real window produced the sentence the bug had been showing
  all along: a project folder created seconds earlier, with all seven of §4's directories in it,
  reported **"this project folder is empty"**. A new project is nothing *but* empty directories, and
  the tree was built from files alone — so the state the bug hurt most was the very first one a user
  meets.

  The sharper form of it: `applyChanges` has always produced directory entries, because the watcher
  reports `isDirectory` and it is carried straight through. Only the initial walk dropped them. **The
  browser therefore disagreed with itself about the same folder depending on how it had heard of it** —
  "New folder" made one appear, and reopening the project made it vanish while it sat on disk the whole
  time. That reads as the folder having failed to be created. The invariant is now a test: the walk and
  the watcher must produce the same entries for a folder with nothing in it.

  Both directions are guarded end to end. A brand-new empty project is its own shell in `smokecheck`,
  because no harness had ever produced one — every other check writes a session file pointing at a
  fixture that already has content, which is exactly the shape that hid this for the life of the
  project.

  Checked before building, twice, and both times the answer was "it already exists": track resizing is
  wired at `App.tsx:2163`, and §5.8's variant ceiling is `AppSettings.variantMaximum`. Neither became
  wasted work. **The sweep is worth running before the build, not after** — its cheapest use is not
  finding gaps but refusing to open ones that are already closed.

- 2026-08-10: The GPU semaphore was invisible, and two harnesses were driving yesterday's build.

  Read the mockups in the design project this time rather than working from the spec alone — 1a–1e are
  the design, 1f–1h are labelled alternatives. One thing in them was not built. **1e says it in as many
  words: "while the segmentation worker holds the GPU semaphore, generator jobs wait — *shown, not
  hidden*".** It was hidden. `describeGpuStatus` carries `GPU busy · segmentation` in its own doc
  comment as the readout "for the title bar", is tested, and was rendered nowhere — so a queued
  generation sat at *queued* with nothing anywhere saying a mask propagation had the card. The waiting
  was correct and unexplained, which reads as the application having hung.

  Serialization itself was never broken: one semaphore per window, and the queue, the export and
  segmentation all go through it. Only the readout was missing. It is silent while the GPU is idle
  **and** nothing waits — a permanent `GPU idle` says the same thing during every second of editing,
  and a status area that is always full is one nobody reads when it finally changes.

  **A contract found by using the thing as what it is.** `getStatus()` built a fresh object per call.
  Every test passed, because they all compare by value — and the first consumer to treat it as a
  subscribable store could not: `useSyncExternalStore` compares snapshots by *identity*, so a store
  that never returns the same object twice reports a change on every render. A store that publishes to
  listeners owes them a stable value between publishes; it is now rebuilt in `publish` and nowhere
  else, and three tests pin the identity rather than the contents.

  **Then twenty minutes went into the application for a fault in the harness.** `exportcheck` reported
  the new readout absent. It was there. `exportcheck` and `perfcheck` never built — each carried
  *"npm run build"* as a line in its header comment, and **a header comment is not a guard**. They were
  driving whatever `smokecheck` last compiled, which is usually the working tree and is never
  guaranteed to be.

  `smokecheck` has had this guard for a while, with a comment recording that its absence "hid a whole
  feature's absence exactly once". So: **the same fix in one harness and not its neighbours, for the
  third time** — the `ENOTEMPTY` teardown retry did it, the track lock did it, and now this. It lives
  in `harness/build-first.mjs` now, called by all three, which is the only form of the lesson that
  survives the next harness being written.

  Worth being exact about the cost: a check that silently drives an old binary does not merely fail to
  catch things. It **accuses working code**, and the time goes into the wrong place at the worst hour.

- 2026-08-10: A failed generation was a dead end.

  Second thing the mockups have that the application did not. A job row in 1c carries
  `retry · cancel · reveal in folder`; the queue had cancel and dismiss and no way to run a request
  again. So a generation that fell over on a backend hiccup showed its reason and its seed and left
  **re-entering every parameter** as the only route back — with the panel very likely showing a
  different generator by then, since the failure arrives minutes later.

  `Activity` gained `actions`, on the activity rather than on the kind, so a later one can offer its
  own — reveal a delivered file, open the folder a failed import was reading — without `StatusBar`
  learning what any of them mean. Rendered under the reason they answer: a row of buttons above the
  failure would be a choice offered before the question.

  **The retry lives in the shell, not the runtime**, and that is forced rather than chosen. Repeating a
  request needs the *manifest*; the queue keeps a generator id, and the registry that resolves one is
  the shell's. A generator removed from the library since the run therefore has no retry and no button
  — offering one that would refuse is worse than offering none.

  Seeds are derived afresh, deliberately. A failed run produced nothing, so there is no image to
  reproduce; the user is asking for the *request* again, not for a particular result. Preserving the
  seed would also have meant `lockedSeed`, which §5.8 forces to a single variant — quietly changing a
  three-variant request into a one-variant one on the way through a retry.

  The retry names the **group**, not the run. A group is the request; a run is one variant of it, and
  retrying a single variant of three would silently alter what was asked for.

- 2026-08-10: Closing the gap I had just admitted to.

  The retry shipped with the pure adapter tested and the wiring only typechecked, and that was said
  out loud rather than implied. Provoking a real backend failure end to end would have meant wiring
  the mock's `failSubmitOn` into the shipped application — **a test hook in production code, to cover
  a lookup.** So the coverage went to where the decisions actually are instead.

  `retryRequest` is now a module of its own, and the callback in `App` is a lookup and a call. That is
  the shape this project keeps arriving at: judgement where it can be checked without rendering, wiring
  short enough to read in one line.

  **It asks for `ManifestSource`, not `GeneratorRegistry`** — one method, `manifestFor`. A function
  that asks for the whole registry cannot be exercised without building one, which means validating
  manifests against a backend to test a lookup; the registry satisfies the narrow interface
  structurally, so the shell passes its own with no adapter. Depending on what you use is the cheaper
  design *and* the testable one, which is not always the same trade.

  Eight tests on the request, four on the list. Two of them pin things a reader would otherwise have to
  take on trust: the variant count survives (a preserved seed would have forced it to one under §5.8),
  and the `preset` key is **absent** rather than `undefined` when there was none, because
  `exactOptionalPropertyTypes` makes those different and the queue reads it with `in`.

  Both mutants run: hiding the action block fails three of the four list tests, and the assertion that
  the reason is shown had to be scoped to the popover — the bar's summary says it too, so the loose
  query matched twice. **That was the component being right and the test being sloppy**, which is worth
  writing down because it is the failure that most often gets "fixed" in the wrong file.

- 2026-08-10: The third job action, and the neighbour fixed at the same time.

  **`Show in folder`**, the last of the mockup's `retry · cancel · reveal in folder`. A generation that
  succeeded leaves files in `generated/` under names nobody chose — a seed and an output key — and the
  only way to reach one was hunting the browser by timestamp. It cost one entry in `activities.ts`,
  which is the test of yesterday's `actions` slot rather than a claim about it.

  The **first** output, not one button per file. A run declares a primary output and its companions —
  a video and its poster frame — and three buttons all named `Show` would ask the user to know which
  key is which. Revealing the primary opens the folder holding every one of them, which is the thing
  they were after.

  **And the job queue got the semaphore's snapshot fix, at the same time and on purpose.** These are
  two `subscribe` + `getSnapshot` pairs in one package; `getSnapshot` rebuilt per call in both. Today's
  consumer copies into state in an effect and is unaffected, so nothing was broken — but the next one
  to reach for the *correct* hook would have looped, exactly as the GPU readout did. Every existing
  test compares by value and would have gone on passing.

  This is the fourth time the phrase has been written here, so it is now a rule rather than an
  observation: **when a fix lands, look for the neighbour with the same shape before moving on.** The
  teardown retry, the track lock, the harness build guard, and now this.

  One thing deliberately *not* deleted: `QueueSnapshot.activeCount` is computed and read by nothing,
  and its comment named a `2 jobs` chip on the title bar that issue #22 replaced with the status bar.
  Unlike `planValidUntil` and the duplicate `snapPoints`, using it would be **correct** — it is merely
  redundant with `runs.filter(...)`. So the comment was the defect, not the field. A doc that names a
  UI which does not exist reads as a feature someone forgot to finish.

- 2026-08-10: Looped playback, and a key the application had been promising.

  The mockups put a `loop` beside the in and out points, and the reason is the ordinary way a cut gets
  judged: you watch the same four seconds twenty times. Playback **stopped** at the out point, so each
  viewing cost a press of play *and* dragging the playhead back — two gestures between every look at
  the thing being decided. The transport's own comment already called the range "the spec's bound on
  looped playback" while nothing looped.

  `loopFrom` is a **frame, not a flag**. What "the loop" means — the in point when a range is marked,
  the top of the sequence otherwise — is the shell's decision, and this hook does not know a work range
  exists. `playbackStart` sits beside `playbackEnd` so the two cannot come to disagree about what the
  marks mean, which would give the loop one range and the export another.

  The subtlety is the **anchor**. Playback advances from a wall-clock start time, so moving the frame
  back without resetting it leaves elapsed time counting from the original start — the very next tick
  is still past the end and the loop collapses into a stutter at the out point. The audio has to be
  re-seeked for the same reason, or the picture returns to the in point while the sound plays on. Both
  are one mutant apart: deleting the re-anchor fails exactly the test written for it.

  **And a control was advertising a chord nothing listened for.** The Snap toggle's tooltip said
  `Snap (N)`; no handler took `n`, and the shortcut sheet — whose own doc says every entry was read off
  the handler that implements it — did not list snap at all. So the sheet was honest and the *toggle*
  was not. Snap, ripple and loop now have `N`, `R` and `L` through one `useModeKeys`, which takes a map
  so a fourth mode is an entry there and a row in the sheet.

  It declines **every** modifier rather than just Ctrl: `Alt+M` removes a marker and `Shift+S` splits
  every track, so a mode key firing on any chord ending in its letter would quietly steal from them.

- 2026-08-10: Twelve bindings that existed and were undocumented, and the check that had to learn about scope.

  Swept every control naming a key — eleven tooltips — against the handlers. All match now; the one
  that did not was yesterday's `Snap (N)`. Then swept the other way, for keys that **work** and are in
  no sheet, which this project treats as not existing at all. Three vocabularies turned up, every one
  of them the only keyboard route to what it does:

  - A focused **keyframe marker**: arrows move it in time and in value, `Shift` for ten frames, `Enter`
    or `Space` cycles the easing, `Delete` removes it.
  - A focused **effect stack row**: `Alt`+arrows reorder, and order is render order.
  - The **variant picker**: arrows compare, `Enter` keeps, `Escape` stops showing the takes.

  This is the same finding as `Alt`-drag once was — implemented, working, reachable only by someone who
  had read the source.

  **And the sheet's collision check had to learn what a scope is.** Adding them tripped
  `binds each chord to exactly one action`, correctly on its own terms: `←` now moves a keyframe, steps
  a variant *and* steps the playhead. That is three bindings on one key and **not** a clash, because no
  two of them are listening at the same moment. The old doc advised explaining such a pair in the
  `note` — which does not help, since the check reports it anyway, and the only way past a false alarm
  is to stop believing the check.

  So `ShortcutGroup` carries a scope and collisions are compared within one. The **first attempt was
  wrong in an instructive way**: a single `focus` scope made the check pass, and it passed by hiding a
  real clash — a keyframe marker and the variant picker both wanted `Enter`. Scopes are per *listener*
  now, which is what they actually are, and the sheet reads better for it: `Keyframe marker`,
  `Effect stack row`, `Variant picker` say where you must be for the key to do anything.

  A coarse scope would have bought a green check by making the check blind. That is the failure this
  whole line of work exists to prevent, arrived at from the other direction.

- 2026-08-10: A hundred and twenty windows, closed by hand.

  Reported by the user, and it was mine. Every harness spawns Electron detached so it can be stopped as
  a group, and that worked **whenever the harness reached its own cleanup**. A `finally` does not run
  when the process is killed from outside, when `browser.close()` hangs on a window that has stopped
  answering, or when a run is cut short — and each of those leaves a real application window on screen.
  They accumulate silently, because the next run starts a fresh one and reports green.

  Three orphaned shells were still up when I looked, from runs twenty-eight, fifteen and four minutes
  old.

  Cleanup is attached to the **process** now, not to a block: `exit`, the signals, `uncaughtException`
  and `unhandledRejection`, all going through one `harness/children.mjs`. Two things it got wrong first,
  both found by testing it rather than reasoning about it:

  - **Untracking on `exit` left three of twelve alive.** What is spawned is `npx electron`, a node
    wrapper that starts the real shell and leaves; its exit says nothing about whether a window is on
    screen. The pid is kept for the life of the run now — killing a group that has already gone raises
    `ESRCH`, which is the outcome wanted anyway.
  - **The stale-run reaper matched my own shell.** Keying on `--user-data-dir=/tmp/nos-*check-` alone
    matches the command that *launches* a harness, anything grepping its output, and anything a person
    types about it. It would have killed the terminal that started it. The process must now *be*
    Electron or its wrapper, and that decision is the one piece of harness code with unit tests —
    because it is the only code here that terminates processes it did not start.

  `SIGKILL` on the harness itself is the case nothing in-process can cover, so the next run reaps
  anything older than half an hour. That turns an unbounded pile into at most one stale window. The age
  test is what makes it safe to do unconditionally: without it, a run started while another was going
  would kill the other one's shell and report its death as the application's.

  Verified by interrupting a real run: twelve shells up, `SIGTERM`, zero left.

- 2026-08-10: How long each piece of media is, in the browser.

  The mockups show `interview_a.mp4  04:12` and the rows carried a name and nothing else, so choosing
  between four takes meant opening each one in turn — the detail panel has known the duration all
  along, one file at a time.

  A duration is not on the filesystem. It is inside the container, and reading it means asking the
  sidecar to probe, so folding it into the directory walk would make **opening a project** wait on an
  ffprobe of every asset in it. It arrives after the tree and independently of it: a hook returns a map
  and a row has no duration until its own answer lands.

  Three at a time, with one worker per slot taking the next path as it finishes rather than fixed
  batches — a batch waits for its slowest member, so one long file would stall two idle slots. Paths
  already asked about are remembered across tree rebuilds, or every watcher event would re-probe the
  whole project.

  A file that cannot be read shows **nothing**, not a dash: a row reading `—` beside rows reading times
  draws the eye to exactly the files that cannot be cut.

  **And the first version was wrong in a way only the export check could show.** It probed each file
  separately through `/media/probe`, whose question is "the metadata, or why not" — so a placeholder a
  generator has not written, a file still encoding, or a container ffprobe cannot read answers 404 or
  422, *correctly*. A browser logs every 4xx to its console whatever the caller does with the promise,
  so one unreadable file in a project became a renderer error on every scan, and `exportcheck` failed
  on it. The fix was not to swallow the error but to ask a different question: `/media/durations`
  answers `null` where there is no duration, because a listing wants "the length if there is one".

  One round trip for a folder of two hundred takes instead of two hundred, and the client's whole
  concurrency-limiting apparatus — three workers pulling from a queue — deleted along with the
  problem it was managing.

- 2026-08-10: Getting back into a project without the folder picker.

  §4 makes a project a folder, and the consequence was that the **only** way in was the system dialog:
  every launch, and every switch between two projects being cut in the same week, began by navigating
  to a place the shell already knew. It has remembered the last project since it learned to reopen —
  it simply never remembered more than one, and never showed what it had.

  `session.json` now carries a list, newest first, capped at eight: enough for the handful someone
  moves between in a week, short enough that the list is read rather than scanned. A history that fills
  the screen is a second file picker.

  **A moved folder is shown and refused, not dropped.** The same rule the generator registry follows
  for an unrunnable generator: a row vanishing on its own is indistinguishable from the application
  having forgotten it, and the user is left wondering which. Shown and unavailable is an answer;
  absent is a mystery.

  A split control, not a menu that swallows the picker. `Open project` stays where it was and does what
  it did — a user who has learned where it is should not have to learn again, and the smoke check finds
  it by that name. The history is a quieter affordance beside it, **hidden entirely** when there is
  none: a disabled control says "there is something here you cannot have", and on a first run there
  genuinely is not.

  The list falls back to `lastProject` when the session file predates it, so the first launch after an
  update offers the project someone was working on rather than an empty history.

  Both halves are checked in the running window, because both are facts about the assembled
  application: that opening a project *wrote it down*, and that the control which reads it *appeared*.

- 2026-08-10: A gap in `verify` worth naming.

  `ruff` is not part of `npm run verify`, and it had drifted: eleven findings on `main` before any of
  today's work, all line length. Two are fixed and none were added. The Python suite (156 tests) does
  run and passes — it is the linter alone that nothing calls, which is exactly how a check stops being
  a check.

- 2026-08-10: `ruff` and the Python suite are part of `verify` now.

  Named as a gap last entry, closed here. Eleven line-length findings on `main` were fixed — and the
  first attempt at fixing them is the part worth recording: a script that re-wrapped every long line by
  width **broke the code**, splitting a `#` comment across two lines and leaving the continuation as a
  bare identifier. Reverted and done by hand. *Formatting is not a text operation on a file; it is one
  on a syntax.*

  `verify` now ends with `lint:py` and `test:py`. The Python tests were being run by hand every cycle,
  which is the same arrangement as a check nobody runs — it works exactly until the day someone is in a
  hurry. Twenty-three seconds is a fair price for not needing to remember.

- 2026-08-10: Zooming the preview.

  The preview letterboxes into whatever room the panel has, which is right and was the only thing on
  offer — so the frame was almost never at its own size. On a 1080p project in a half-window panel that
  is around two thirds, and at two thirds you cannot judge a mask edge, a title's kerning or the grain a
  shader just added, which is most of what this application is for. The mockups' `fit · 68%` is the same
  observation: the number matters because it says what you are **not** seeing.

  **The drawing buffer stays at the project resolution.** Rendering more pixels because someone zoomed
  would make the preview disagree with the export, which is the guarantee §6.7 rests on. What changes is
  how large that buffer is *drawn*, so zooming shows the frame's real pixels bigger and never invents
  any.

  One transform over the canvas **and** the mask overlay, which is what keeps segmentation correct for
  free: a click's rectangle arithmetic is against what the user actually sees, so a point lands where it
  was put at any zoom. That did need one real change — the picture is measured with `offsetWidth` now
  rather than `getBoundingClientRect`, because a rect is the *transformed* box and the overlay, drawn at
  that size inside the transform, would have been scaled twice.

  The gestures avoid the ones already spoken for: `Ctrl`+wheel because a bare wheel scrolls the panel,
  and the **middle** button to pan because the primary places mask points and the secondary opens menus
  — on the very panel where masks are drawn. Double-click returns to fit.

  The pan is bounded by the overhang, so the picture cannot be dragged off into an empty box with no
  clue how to get back. At fit the overhang is zero, which is why zooming out re-centres without being
  told to.

  `NaN` is the one value clamped specially, and the test says why: it has no order, so `Math.min` and
  `Math.max` pass it straight through, and it reaches CSS as an invalid transform that makes the picture
  vanish with nothing logged. Infinity needs no special case, and pretending it did would have hidden
  the one value that does.

- 2026-08-10: The history, as a list rather than two buttons.

  The store has recorded a label on **every** commit since M1 and the whole stack has been in the
  snapshot just as long; two buttons could only ever read the top of it. The question a user has after
  ten minutes of cutting is not "what does undo do" — it is *what did I do, and how far back is the
  point I want*. The previous answer was to press `Ctrl+Z` ten times and watch for the moment it looked
  right, which is ten chances to overshoot, and overshooting is how a redo stack gets thrown away.

  **`jump` moves by an offset, not to an index.** A list rendered a moment ago names a step that a
  commit in between may have dropped, and an index into a stack that has changed points at the wrong
  edit. It is built from repeated `undo`/`redo` rather than by reaching into the stacks, because those
  two already carry the rules about what a step *is* — a second way of arriving at a state is a second
  thing to keep correct. Clamped by construction: each call is a no-op at the end of its stack.

  Undone steps stay on the list, dimmed. Dropping them would make redo look like a dead button, and the
  moment right after an undo is exactly when someone wants to see what they just left behind.

  **And it broke the story board — through the harness, not the code.** `getByRole('button', {name:
  'Story'})` matches an accessible name by case-insensitive **substring**, and `History` contains
  `story`. The new control sits earlier in the title bar, so `.first()` found it and the run reported
  that the Story button did not open a story tab. The second time this exact trap has been sprung here
  — `Film Grain` matched a stack row the same way — so the names in that check are pinned with `exact`
  now.

  Worth stating plainly: **the failure was real and pointed at the wrong file.** A green story-board
  check would have been a lie, and a red one that accused working code cost the time it takes to read
  the DOM order. A harness that matches loosely is a harness that will eventually accuse the code.

- 2026-08-10: Markers as a list, zoom controls, and a lesson about mechanical fixes.

  **The markers.** They have carried a label and a colour since the document model was written and the
  ruler draws them — but a ruler shows the stretch of sequence that happens to be on screen, and the
  only way through them was `Alt`+arrow, one at a time and blind. On a twenty-minute cut the question
  is *where did I note the thing about the interview*, and the answer was to step through every flag
  until one said so. A tab is one entry in `PANEL_TABS`, which is what that list being data was for.

  The timecode is the button. It is what identifies a marker — two can share a name, none can share a
  frame — so making the identifier the way there saves the row a second control competing with the
  name field. Placing one stays on the ruler: a marker is put down *at a moment*, not chosen from a
  menu.

  **The preview's zoom got controls**, because a capability reachable only by `Ctrl`+wheel is one only
  a reader of the shortcut sheet has. The readout is the way back — it already says where you are, so
  making it say *and click here to return* costs no width where a third button would.

  **And that readout broke `perfcheck`.** `getByRole('button', { name: 'Fit' })` matched `fit · 44%`.
  Third time for this trap in two days — `Film Grain` matched a stack row, `History` matched `Story`,
  and now this.

  So I added `exact: true` to every plain-string name in all three harnesses, mechanically, with a
  regex. **That was worse.** It broke five checks at once: `exact` compares case as well, so a
  lowercase `generate` stopped matching the `Generate` tab; and a menu item's accessible name includes
  its shortcut, so `Crossfade at the cut` is really `Crossfade at the cutShift+F`. Undoing it
  mechanically then removed an `exact` that `exportcheck` had held for a documented reason — the
  comment explaining it sat three lines above the line the regex rewrote.

  The rule that survives is narrower than "always be exact": **a name needs `exact` when it is a
  prefix of another label on the same role, and must not have it when the accessible name is composed
  of more than the label.** Which of the two applies is a fact about the UI, not something a regex can
  read.

  The larger lesson is the one that cost the time: *a mechanical fix applied across files that contain
  hand-reasoned exceptions will delete the reasoning.* Both directions of this change were wrong in the
  same way, and the file said so in a comment before I started.

- 2026-08-10: A README, from photographs of the running application (issue #39).

  The issue asked for pictures and a video **of the app**, a centred title, and no invented prose. So
  the pictures had to be *of the app*: a mockup, or a drawing of one, would be the thing the issue asked
  not to have. `apps/desktop/capture/` drives the real shell exactly as the checks do and photographs
  what appears.

  **The project it photographs is synthesized, not committed.** A screenshot of an empty timeline says
  nothing about an editor, and committing sample footage to prove that would be paying for the picture
  twice — ffmpeg makes four shots and a tone, and the document naming them is a module of its own
  because a hand-written document can be wrong. It is now checked by the suite, which is how the first
  one's four faults were found in a millisecond instead of by watching a launch time out: on disk a
  constant parameter is a bare number and `{ kind: 'static', value: 0 }` is the *in-memory* shape.

  **Three corrections to the capture, each from looking at the result rather than assuming it.**
  A forced click at a wide clip's centre lands on the drag zone, so the first two pictures showed an
  unselected clip and a panel saying so — the label's corner selects. A double-click renames a clip
  rather than opening its lanes; the disclosure the body already offers does that, and only exists on a
  clip that *has* an animation. And recording real-time playback produced a black preview and `1 layers
  still decoding` across the dissolve — true of the first play of an unwarmed timeline, and a picture of
  the decoder rather than of the editor. A warm-up pass did not help, because each play seeks and
  decodes again. Stepping ten frames at a time is paced by the screenshot, so every recorded frame is
  one the compositor had finished, and the walk covers the whole cut instead of its first two seconds.

  A GIF as well as the mp4, because GitHub renders an `<img>` inline and does not reliably play a
  `<video>` pointing into the repository. Two ffmpeg passes with a generated palette: the default
  216-colour web palette bands a dark interface, and a dark interface is the entire subject. 637 KB.

  `harness/shell.mjs` came out of this — the capture was the fourth thing to need "spawn Electron on a
  free port and retry the connection", and the three copies had already drifted in attempt counts and
  intervals.

  **And it found a performance regression of my own making.** `perfcheck` reported a 50 ms block once
  and passed on re-run, so the number was not the evidence — but the cause was there to find:
  `StoreSnapshot.steps` walked the whole history on **every publish**, and a publish happens per pointer
  move during a coalesced drag. It is a lazy getter now, cached per snapshot: lazy alone would hand back
  a new array per read, and the shell memoizes its history controls on that identity. An intermittent
  number was a true signal about work on the wrong path.

- 2026-08-10: A narration generator, and what the hardware will actually do (issue #40).

  The issue asks for a three-minute promo made *with* the program, narrated by the TTS in a female
  voice. Two facts had to be established before any of it could be planned, and both changed the plan.

  **The shipped TTS cannot do it alone.** `fish_s2_voiceclone_hu` is a voice *clone*: it requires a
  reference sample, and there is not one audio file in the repository. So `fish_s2_narration` was added
  — a manifest over ComfyUI's `FishS2TTS`, which needs no reference — because §5 makes a new capability
  a manifest rather than code, and this is exactly that case.

  It works on `s2-pro-bnb-nf4` with `offload_to_cpu`; the unquantised weights exceed 16 GB. And it
  offers **no speaker selection** — the voice follows the seed. Eight seeds measured by median F0:
  95, 104, 88, 96, 101, 104, 82, 147 Hz. All in the male band; a female speaking voice sits around
  165–255 Hz. The measurement is a proxy for one decision between two bands an octave apart and says
  nothing about whether a voice is good — but it is the only handle available to something that cannot
  listen.

  So the female voice is **blocked on a sample the user has to provide**, and deliberately not worked
  around: cloning a stranger's voice is a consent problem, and pitch-shifting a male voice up while
  calling it "the girl's voice" is a misrepresentation. The script lives in `notes/` so the existing
  clone generator can read it from a notes file the moment a sample exists.

  **And the card decides the shot length.** 4 s at 0.4 MP took 271 s — about 68 s of compute per second
  of video. Twelve 15-second clips is three hours before a single cut. Worse, longer clips *restart the
  ComfyUI process*: twelve seconds queued eight deep killed it, then ten seconds on its own killed it
  again, while four seconds completes reliably. So the beds are twelve of five seconds, and the three
  minutes gets built the way an editor builds one — repeats at different speeds, titles over held
  frames, and the application's own footage between them.

  Two faults of my own along the way, both in the runner rather than in ComfyUI. Queueing eight heavy
  jobs at once is what restarted the server the first time. And polling `/history` every two seconds
  while the GPU is saturated gets connections reset — treating a reset as a failed job threw away work
  that was still running, and treating a *missing* job as "not started yet" waited forty minutes for a
  job the server had forgotten in a restart. The queue is now one job deep, transient errors retry, and
  a prompt that is in neither the queue nor the history is recognised as lost.

- 2026-08-10: The promo's edit, and the limit that shapes it (issue #40).

  **The cut is data.** `promo/edit.mjs` is the edit decision list — ten sections of eighteen seconds, one
  per narration block, each cutting bed, app, bed, app, bed, app. Sixty shots, 5400 frames, exactly three
  minutes, and `promo/build-project.mjs` turns it into a `project.json` the application opens.

  Written rather than clicked together, and that is the honest division: an EDL is data, and typing sixty
  shots into a timeline through a Playwright script would be a worse test of the program than opening the
  result and cutting it. What it does prove is that the shape a real edit needs — four tracks, per-shot
  ramps, keyframed titles, section markers — is expressible in the file format and renders through the
  same compositor the export uses.

  **The first version of the cut was wrong, and the test now says so.** It asked for 150-frame shots off
  a 120-frame bed: a whole second of material that does not exist, at the end of thirty of the forty
  shots. Nothing refuses that — a clip simply runs past its own media — so `SOURCE_FRAMES` states what
  each source holds and a test asserts no shot exceeds it. Fast cuts rather than slow motion for the
  same honesty: retiming a 24 fps bed to half speed on a 30 fps timeline shows every source frame two or
  three times, which on hard-edged motion graphics reads as a stutter.

  **And the real constraint is not the GPU.** ComfyUI here runs in a Docker container with a memory
  cgroup limit; the kernel log shows sixteen OOM kills on *host* RAM at about 25 GB of anonymous memory,
  on jobs of twelve, ten, five and even four seconds. Whether a given render survives is marginal — some
  four-second jobs finish, some do not — so the runner retries a lost job three times rather than
  treating it as a verdict on the prompt. Raising the container's memory limit is the fix, and it is the
  user's to make.

  Three of my own faults were in the runner and are recorded because each cost real time: eight jobs
  queued at once, a reset treated as a failure, and a job the server had forgotten treated as one that
  had not started. The lesson underneath all three is the same as the one about the mechanical `exact`
  edit — **read the log before forming a theory.** "Longer clips are heavier" got the direction right and
  the cause wrong, and `dmesg` had the answer from the first failure onward.

- 2026-08-10: The trim guard had no data, found by making the bug it prevents.

  Writing the promo's edit produced a document whose shots ran a second past their four-second beds, and
  the application drew it without a word. Chasing that turned up something larger than a missing badge.

  **`SourceBoundsResolver` has existed since M2, every trim consults it, and nothing ever supplied one.**
  `options.sources` was undefined at every call site in the shell, which the contract documents as
  "proceed unchecked" — so `trimClip`'s refusal, the `source-exhausted` error, and the message naming how
  many frames were missing could never fire. An edge could be dragged well past the end of a shot and the
  clip simply showed whatever the decoder had left.

  The guard was written, tested, and never connected to the thing it protects. That is the same shape as
  the keyframe value, the clip transform, the mask sampler, the pass budget and the GPU readout — the
  sixth time on this list, and the first one where the *engine* was complete and only the **input** was
  missing. Worth naming as its own variety: not "nothing calls it" but "everything calls it, with
  nothing".

  `useSourceBounds` probes each distinct video and audio source once and hands the trims a resolver.
  Audio keeps its duration in *seconds* in the cache and is converted where the clip is in hand, because
  the rate belongs to the clip — `source.sourceRate` is what that clip's `sourceIn` counts in, and a
  hard-coded 30 would be wrong for every other rate.

  And the document itself is now swept: `clipsPastTheirSource` reports a clip asking for material that
  does not exist, honouring retimes so a shot at 0.5× is not falsely accused, and leaving stills alone
  because holding one frame is what a still is *for*. Reported, not repaired — shortening the clip would
  be an edit nobody asked for, and one that cannot be undone from a state the user never saw. Three ways
  in exist that no trim can catch: a hand-written project, a relink to a shorter take, and a source
  replaced on disk.

- 2026-08-10: The promo, and the two faults using the program turned up.

  A 72-second promo exists, cut and **rendered by the application**: 1920×1080, 2160 frames, four tracks,
  per-shot ramps, keyframed titles, section markers. `promo/build-project.mjs` writes the document and
  `promo/export.mjs` drives the shell and reads the delivered file back with ffprobe rather than trusting
  the dialog.

  **Not three minutes, and the reason is stated rather than padded over.** One bed of twelve rendered; the
  container's memory limit killed the rest. Three minutes from one four-second clip would be that clip
  thirty times, which is padding wearing the shape of an edit. So `honestLength` derives the length from
  the material — a bed may appear four times, a screen recording six, because a two-second recording makes
  a *different* claim each time it appears and a four-second abstract bed does not. The same function
  returns the full three minutes the moment the beds exist.

  The per-kind limit was one number first, and the test caught what that cost: six recordings at four
  showings each ran out two sections early, and **the application disappeared from the last thirty-six
  seconds of its own promo.**

  ## Two faults found by using it

  **`waitForFunction`'s third argument is the options.** Every harness passed `{ timeout }` in the second
  position, where it is the *page function's argument* — so all of them ran on the default thirty seconds,
  and `exportcheck`'s stated 180-second limit had never been in force. It only showed when a 2160-frame
  export needed longer than thirty seconds. Six files fixed. A wrong-position argument is invisible while
  every wait happens to be short.

  **A clip may outrun its media, and now it says which one.** `clipsPastTheirSource` gives the status line
  one sentence; `ClipBody` marks the clip itself in amber — the two read one sweep, because two would be
  two chances to disagree about the same document. The mark defers to `offline`: a missing file outruns its
  source by the clip's whole length, so the missing file is the fault and the length is a consequence, and
  two marks for one problem is one too many.

- 2026-08-10: A button with nothing behind it.

  The export dialog has carried a **Browse** button beside its destination field since it was written. It
  renders unconditionally, and `onBrowse` was never supplied by anyone — so it appeared, and clicking it
  did nothing at all. Not a missing feature but a *lying* one: every other gap of this shape at least had
  the decency to be invisible.

  Found by the sweep that finally works on props. Earlier attempts keyed on `name:` and missed JSX
  entirely; searching for `prop={` against the interfaces in `packages/ui` is what surfaced it, and the
  same pass confirmed `existingFiles`, `onTrackResize` and `snapIndicator` *are* wired — which is the
  half of a sweep that stops it becoming a source of invented work.

  `chooseExportPath` is the channel behind it: a save dialog defaulted into `renders/`, answered as a
  **project-relative** path because that is what `ExportSettings.outputPath` is and what the sidecar
  resolves.

  **Its two failures are kept apart, and that took a correction.** `toProjectRelative` answers `undefined`
  both for a path outside the project and — via a cancelled dialog — for no path at all, so the first
  version could not tell a decision from a mistake. The channel now returns `undefined` for a cancel and
  the empty string for a destination outside the folder: a cancel needs nothing said, and a choice
  outside needs a reason. Refused rather than rewritten, because a picker that quietly moves the file
  somewhere else is worse than one that says no.

  And the trim guard from the previous entry is now verified in the running window: `smokecheck` drags the
  audio clip's out-point well past the end of its one-second tone and asserts the clip did not grow.

- 2026-08-10: The promo has sound, because the audio model fits where the video one does not.

  `stable_audio_3` rendered eighty seconds of underscore in **twelve seconds** and three one-shots in six
  each — in the same container that is OOM-killed by a four-second video. The models are not the same size,
  and assuming "generation is blocked" from one of them would have left a silent promo on the strength of
  the wrong evidence. Worth naming: *a blocked pipeline is blocked per model, not per machine.*

  So the promo now carries a music bed, a riser leading into each even section, an impact landing on each
  odd one, and a tick cluster opening the film. Which is the right way round for a short piece: a silent
  promo reads as broken, a short one only reads as short.

  **The accents are butt-jointed, not layered, and that is forced.** The editing rules refuse a collision
  rather than resolving it — a clip is never displaced to make room — so a builder emitting two overlapping
  clips on one track produces a document the application will not accept. The opening riser and the tick
  cluster overlapped in the first version by exactly that much. They are pushed to the previous end rather
  than dropped: an accent two frames late is still an accent, where a silently lost one leaves a cut with
  nothing on it for no stated reason.

  The bed sits at `0.2` linear rather than unity, because the accents are what a viewer registers and the
  bed is what they feel. A separate `A3` is left empty for the narration, which still needs a voice sample.

  One thing I cannot verify and will not claim: **whether the music contains singing.** The prompt asked for
  none and the negative prompt names vocals, speech, singing and lyrics — but median F0 measures a sub bass
  at 92 Hz just as happily as a voice, so the measurement that settled the TTS question says nothing here.
  It needs an ear.
