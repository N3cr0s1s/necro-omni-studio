/**
 * Runs the compositor GL verification harness and asserts the read-back pixels.
 *
 * Why this exists as a separate check rather than a Vitest test: the executor needs a real WebGL2
 * driver. A mocked context can only assert that calls happened in some order — it cannot catch a wrong
 * blend factor, an incomplete framebuffer, a sampler bound to the wrong unit, or a ping-pong that reads
 * its own output. Every one of those is silent in a mock and visible in a pixel.
 *
 * Usage, from the repository root:
 *   cd packages/compositor && npx vite --port 5200 &
 *   node packages/compositor/glcheck/run.mjs
 *
 * Exits non-zero if any expectation fails, so it can gate a release.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
/*
 * The address the harness page is served at.
 *
 * Taken from the environment when `serve-and-run` started the server, so the port is one nothing else
 * holds and the server is provably *this* package's. The literal remains for the documented two-shell
 * dance — which has a trap in it: served from the wrong directory, the check still reaches a page and
 * reports 24 of 27 failing, which reads as a compositor in ruins rather than a harness pointed at the
 * wrong application.
 */
await page.goto(process.env.NOS_GLCHECK_URL ?? 'http://localhost:5200/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__glcheck !== undefined, { timeout: 20000 }).catch(() => {});
const r = await page.evaluate(() => window.__glcheck ?? null);

/** Expected values, derived by hand from the shaders in the harness. */
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const px = (k) => r?.[k]?.pixel ?? [];
const checks = {
  'bare layer reproduces its source': near(px('bareLayer')[0], 255) && near(px('bareLayer')[1], 0),
  'one pass runs and its uniform is set': near(px('onePass')[0], 0) && near(px('onePass')[1], 255),
  'two passes chain through ping-pong': near(px('chainedPasses')[0], 64),
  'mask binds to its own texture unit': near(px('maskBinding')[0], 128),
  'built-in uniforms are set from the layer':
    near(px('builtins')[0], 128) && near(px('builtins')[1], 255) && near(px('builtins')[2], 64),
  'broken shader degrades to passthrough':
    near(px('brokenShader')[0], 255) && r?.brokenShader?.stats?.passesExecuted === 0,
  'shader diagnostic rebases onto line 1': r?.programFailures?.[0]?.firstDiagnosticLine === 1,
  'opacity blends source-over': near(px('opacityBlend')[0], 128) && near(px('opacityBlend')[2], 128),
  'later layer wins when opaque': near(px('layerOrder')[2], 255) && near(px('layerOrder')[0], 0),
  'transition at 0 shows from': near(px('transitionStart')[0], 255),
  'transition at 1 shows to': near(px('transitionEnd')[2], 255),
  'missing texture skips only its layer':
    near(px('missingTexture')[0], 255) && r?.missingTexture?.stats?.layersSkipped === 1,
  'no render targets leak': r?.poolLeak?.borrowedAfterRender === 0,
  'no accumulation over 30 frames': r?.poolAfterManyFrames?.borrowed === 0,
  'output is stable after many frames': near(px('stableRepeat')[0], 64),
  'no GL errors': Object.values(r ?? {}).every((v) => v.glError === undefined || v.glError === 0),
  // Every shipped built-in must compile: a fresh install shows these in its menu.
  'every built-in effect compiles':
    Array.isArray(r?.builtinLibrary) &&
    r.builtinLibrary.length > 0 &&
    r.builtinLibrary.every((b) => b.compiled),
  // The mask path end to end: run-length counts -> RGBA -> texture -> sampler.
  'a decoded mask uploads': r?.decodedMask?.uploaded === true,
  'the decoded mask covers half the frame': r?.decodedMask?.area === 64 * 32,
  'masked-in pixels keep the source': near(r?.decodedMask?.inside?.[0] ?? -1, 255),
  'masked-out pixels are cut away': near(r?.decodedMask?.outside?.[0] ?? -1, 0),
  // A column-major/row-major swap would split the frame top/bottom instead of left/right, which every
  // square fixture hides.
  'the mask is not transposed':
    near(r?.decodedMask?.top?.[0] ?? -1, 0) && near(r?.decodedMask?.bottom?.[0] ?? -1, 0),

  /*
   * The dissolve an overlap makes, read as pixels.
   *
   * Every layer under this is unit-tested and none of them can say what the frame looks like: two
   * clips at the right opacities composited in the wrong order is a plausible plan and a wrong
   * picture. Outside the overlap each shot is whole; halfway through it the frame is half of each.
   */
  'before the overlap the outgoing shot is whole':
    near(r?.dissolve?.before?.[0] ?? -1, 255) && near(r?.dissolve?.before?.[2] ?? -1, 0),
  'after it the incoming shot is whole':
    near(r?.dissolve?.after?.[2] ?? -1, 255) && near(r?.dissolve?.after?.[0] ?? -1, 0),
  'halfway through, the frame is half of each':
    near(r?.dissolve?.middle?.[0] ?? -1, 128) && near(r?.dissolve?.middle?.[2] ?? -1, 128),
  // A dissolve that let the empty frame show through would read darker than either shot. The two
  // channels summing to a whole one is what says the picture never went dark in the middle.
  'the dissolve never goes dark': (r?.dissolve?.middle?.[0] ?? 0) + (r?.dissolve?.middle?.[2] ?? 0) > 235,
  'the dissolve raises no GL error': r?.dissolve?.glError === 0,

  /*
   * A transition over an overlap that already carries ramps.
   *
   * The shader is the blend inside its own span, so a hard wipe must show each shot *whole* on its
   * own side. Half-strength either side would mean the ramps were applied as well, which reads as a
   * dip through the middle of a cut.
   */
  'the wipe shows the incoming shot whole':
    near(r?.transitionOverFade?.incomingSide?.[2] ?? -1, 255) &&
    near(r?.transitionOverFade?.incomingSide?.[0] ?? -1, 0),
  'the wipe shows the outgoing shot whole':
    near(r?.transitionOverFade?.outgoingSide?.[0] ?? -1, 255) &&
    near(r?.transitionOverFade?.outgoingSide?.[2] ?? -1, 0),
  // The control: the same document without the transition dips, because both ramps are at half and
  // the empty frame shows between them. If this passed too, the ramps never mattered and the check
  // above would be proving nothing.
  'without the transition the same frame dips':
    (r?.transitionOverFade?.withoutTransition?.[0] ?? 0) +
      (r?.transitionOverFade?.withoutTransition?.[2] ?? 0) <
    235,
  'the transition raises no GL error': r?.transitionOverFade?.glError === 0,
};
const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);
console.log(
  JSON.stringify(
    {
      errors,
      passed: Object.keys(checks).length - failed.length,
      total: Object.keys(checks).length,
      failed,
      pixels: Object.fromEntries(
        Object.entries(r ?? {})
          .filter(([k]) => k !== 'builtinLibrary')
          .map(([k, v]) => [k, v.pixel ?? v]),
      ),
      builtinLibrary: r?.builtinLibrary,
    },
    null,
    2,
  ),
);
await browser.close();
process.exit(errors.length === 0 && failed.length === 0 ? 0 : 1);
