import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The categorical roles never carry words.
 *
 * `chart-1` … `chart-5` are fills. Measured against the surfaces this application draws them on, they
 * run from 10.5:1 down to **1.42:1** across the six shipped palettes — not one of them clears AA as
 * text in every theme, and several fail badly in the appearance the editor opens in. The timeline
 * found this first and wrote it down; the theme audit then found it everywhere else, in a dozen
 * places, including the variant picker's seed at 2.90:1 in the default dark appearance.
 *
 * Fixing those was one afternoon. Keeping them fixed is this: the rule is mechanical, so it is
 * checked mechanically rather than remembered.
 *
 * ## The rule
 *
 * A `text-chart-*` class may appear in JSX only on a **self-closing** element — which is to say on an
 * icon, which has no text of its own. Anything with a closing tag is a container that will hold
 * words, and its words would be drawn in a fill colour.
 *
 * Outside JSX the class is a value rather than a rendering — `glyphs.ts` names a tone per asset type,
 * and the timeline names one per track kind, both of which are then applied to a glyph. Those are not
 * matched, because a string is not a paint.
 *
 * `bg-chart-*` and `border-chart-*` are deliberately not matched either. A fill is what these roles
 * are for.
 */

const ROOTS = ['packages/ui/src', 'apps/desktop/src'];

/** Every source file under the roots, from the repository root wherever vitest was started. */
function sourceFiles(): readonly string[] {
  const repo = new URL('../../../..', import.meta.url).pathname;
  const found: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') walk(path);
      } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
        found.push(path);
      }
    }
  }

  for (const root of ROOTS) walk(join(repo, root));
  return found;
}

/**
 * Where a chart tone is painted onto something that can hold text.
 *
 * Finds the tag the class sits in by walking back to its `<`, then forward to the `>` that closes the
 * opening tag, and asks whether that `>` was preceded by a slash. Crude, and right for this codebase:
 * every icon here is self-closing and every container is not.
 *
 * String literals outside a tag — a tone named as a value — are skipped, which is why the walk back
 * stops at a newline-delimited statement rather than running to the top of the file.
 */
function chartToneOnText(source: string): readonly string[] {
  const offences: string[] = [];

  for (const match of source.matchAll(/text-chart-[1-5]/g)) {
    const at = match.index;
    const open = source.lastIndexOf('<', at);
    if (open === -1) continue;

    // A tone written as a value rather than inside a tag: `tone: 'text-chart-1'`, or a `return`. The
    // giveaway is a statement boundary between the tag and the class.
    const between = source.slice(open, at);
    if (/[;}]\s*$/.test(between) || /\breturn\b/.test(between)) continue;

    const close = source.indexOf('>', at);
    if (close === -1) continue;
    if (source[close - 1] === '/') continue;

    const line = source.slice(0, at).split('\n').length;
    offences.push(
      `line ${line}: ${source
        .slice(open, close + 1)
        .replace(/\s+/g, ' ')
        .slice(0, 110)}`,
    );
  }

  return offences;
}

describe('the categorical roles', () => {
  it.each(sourceFiles().map((file) => [file.split('/').slice(-2).join('/'), file] as const))(
    '%s paints them onto glyphs, never onto words',
    (_name, file) => {
      expect(chartToneOnText(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );
});

describe('the check itself', () => {
  it('catches a tone on an element that holds text', () => {
    // The exact shape that was in the variant picker, at 2.90:1 in the default appearance.
    expect(chartToneOnText('<span className="text-chart-4">{seed}</span>')).toHaveLength(1);
  });

  it('allows a tone on a self-closing glyph', () => {
    expect(chartToneOnText('<SparklesIcon className="text-chart-4" />')).toEqual([]);
  });

  it('allows a tone written as a value rather than painted', () => {
    // `glyphs.ts` names one per asset type and the timeline one per track kind; both are handed to an
    // icon afterwards.
    expect(chartToneOnText("return { icon: FilmIcon, tone: 'text-chart-1', label: 'video' };")).toEqual([]);
    expect(chartToneOnText("switch (kind) {\n  case 'audio':\n    return 'text-chart-2';\n}")).toEqual([]);
  });

  it('says which line, so a failure is one jump rather than a search', () => {
    const found = chartToneOnText('<div>\n<p className="text-chart-2">hi</p>\n</div>');
    expect(found[0]).toContain('line 2');
  });
});
