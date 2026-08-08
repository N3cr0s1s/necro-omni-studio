/**
 * Runs the text rasterizer harness and asserts its results.
 *
 * Separate from Vitest because glyph measurement needs a real font engine: the properties that matter —
 * advances agreeing with what is drawn, wrapping respecting the box — cannot be verified against a stub.
 *
 * Usage from the repository root:
 *   cd packages/text && npx vite --port 5201 &
 *   node packages/text/rastercheck/run.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5201/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__rastercheck !== undefined, { timeout: 20000 }).catch(() => {});
const r = await page.evaluate(() => window.__rastercheck ?? null);

const checks = {
  'one advance per character':            r?.basic?.advanceCount === r?.basic?.textLength,
  'advances are monotonic':               r?.basic?.monotonic === true,
  'last advance equals the line width':   r?.basic?.lastAdvanceMatchesWidth === true,
  'glyphs are actually drawn':            r?.basic?.hasInk === true,
  'wrapping produces multiple lines':     (r?.wrapping?.lines ?? 0) > 1,
  'every wrapped line fits the box':      r?.wrapping?.everyLineFits === true,
  'wrapping preserves the characters':    r?.wrapping?.charactersPreserved === true,
  'letter spacing widens the line':       r?.letterSpacing?.widerWithSpacing === true,
  'letter spacing grows the advances':    r?.letterSpacing?.advancesGrew === true,
  'left align starts at the origin':      r?.alignment?.leftOriginIsZero === true,
  'centre align insets the short line':   r?.alignment?.shortLineInset === true,
  'baselines are one line height apart':  r?.multiline?.gapsEqual === true,
  'outline and shadow add ink':           r?.decoration?.moreInk === true,
  'texture grows to fit an outline':      r?.decoration?.grew === true,
  'typewriter clips on a glyph boundary': r?.typewriter?.widthMatchesAdvance === true,
  'typewriter completes at one':          r?.typewriter?.fullAtOne === true,
  'cache returns the stored object':      r?.cache?.hitIsSameObject === true,
  'cache keeps a just-created entry':     r?.cache?.sizeAfterFirstSweep === 2,
  'cache sweeps untouched entries':       r?.cache?.sizeAfterSweep === 1 && r?.cache?.survivorIsTouched === true,
};

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
console.log(JSON.stringify({ errors, passed: Object.keys(checks).length - failed.length, total: Object.keys(checks).length, failed, results: r }, null, 2));
await browser.close();
process.exit(errors.length === 0 && failed.length === 0 ? 0 : 1);
