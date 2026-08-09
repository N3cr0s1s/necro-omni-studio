/**
 * Whether JSON parses, and exactly where it stopped.
 *
 * The editor refuses to save a file that does not parse, which is the one guard that matters here:
 * saving invalid JSON over a manifest is how a project stops loading, and the editor can see the
 * problem *before* the file exists rather than reporting it afterwards.
 *
 * ## Why the position is found here rather than read from the engine
 *
 * The first version scraped `position (\d+)` out of `JSON.parse`'s message. V8 stopped emitting that
 * — a modern failure reads `Unexpected token ',', "{...}" is not valid JSON` and names no position at
 * all — so the line quietly disappeared from every message the editor showed, and nothing failed. An
 * error report that depends on another program's prose is one that breaks on an update you did not
 * make, silently, in the direction of saying less.
 *
 * So the *text* still comes from the engine, which phrases it better than a hand-rolled parser would,
 * and the *position* is found by scanning. That also gives a column, which is what lets the editor
 * underline the offending token instead of the whole line.
 */

export interface JsonProblem {
  readonly message: string;
  /** 1-based, or `undefined` when nothing could be located — an empty document, say. */
  readonly line?: number;
  /** 1-based, and only ever present alongside a line. */
  readonly column?: number;
  /** Character offset the scan stopped at. */
  readonly offset?: number;
}

export function jsonProblem(source: string): JsonProblem | undefined {
  if (source.trim() === '') return undefined;

  try {
    JSON.parse(source);
    return undefined;
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    const offset = firstProblemOffset(source);
    if (offset === undefined) return { message };

    const before = source.slice(0, offset);
    const lines = before.split('\n');
    return {
      message,
      line: lines.length,
      column: (lines[lines.length - 1]?.length ?? 0) + 1,
      offset,
    };
  }
}

/**
 * The offset of the first character that cannot be part of a valid document.
 *
 * A hand-written scanner rather than a parse: it has to answer for text that is *not* JSON, which is
 * the only case it is ever called on. It agrees with `JSON.parse` about what is valid — that is what
 * the tests check — and its one extra job is to say where.
 *
 * `undefined` when the whole document scans cleanly. That happens when `JSON.parse` rejected
 * something this scanner does not model, and returning no position is the honest answer: a wrong line
 * is worse than none, because it sends the reader somewhere the problem is not.
 */
function firstProblemOffset(source: string): number | undefined {
  let at = 0;

  const skipSpace = (): void => {
    while (at < source.length && /\s/u.test(source[at]!)) at += 1;
  };

  /** Scans one value, returning the offset of the first problem inside it. */
  const scanValue = (depth: number): number | undefined => {
    // A document nested past any plausible manifest is refused rather than recursed into, so a
    // pathological file cannot exhaust the stack in an editor that runs this on every keystroke.
    if (depth > 200) return at;

    skipSpace();
    if (at >= source.length) return at;

    const character = source[at]!;

    if (character === '{') return scanObject(depth);
    if (character === '[') return scanArray(depth);
    if (character === '"') return scanString();

    const literal = /^(?:true|false|null)/u.exec(source.slice(at));
    if (literal !== null) {
      at += literal[0].length;
      return undefined;
    }

    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/u.exec(source.slice(at));
    if (number !== null && number[0].length > 0) {
      at += number[0].length;
      return undefined;
    }

    return at;
  };

  const scanString = (): number | undefined => {
    const start = at;
    at += 1;
    while (at < source.length) {
      const character = source[at]!;
      if (character === '\\') {
        at += 2;
        continue;
      }
      if (character === '"') {
        at += 1;
        return undefined;
      }
      // A raw newline inside a string is invalid JSON, and reporting the opening quote is more use
      // than reporting the newline: the missing quote is what the author has to fix.
      if (character === '\n') return start;
      at += 1;
    }
    return start;
  };

  const scanObject = (depth: number): number | undefined => {
    at += 1;
    skipSpace();
    if (source[at] === '}') {
      at += 1;
      return undefined;
    }

    for (;;) {
      skipSpace();
      if (at >= source.length) return at;
      if (source[at] !== '"') return at;

      const key = scanString();
      if (key !== undefined) return key;

      skipSpace();
      if (source[at] !== ':') return at;
      at += 1;

      const value = scanValue(depth + 1);
      if (value !== undefined) return value;

      skipSpace();
      if (source[at] === ',') {
        at += 1;
        continue;
      }
      if (source[at] === '}') {
        at += 1;
        return undefined;
      }
      return at;
    }
  };

  const scanArray = (depth: number): number | undefined => {
    at += 1;
    skipSpace();
    if (source[at] === ']') {
      at += 1;
      return undefined;
    }

    for (;;) {
      const value = scanValue(depth + 1);
      if (value !== undefined) return value;

      skipSpace();
      if (source[at] === ',') {
        at += 1;
        continue;
      }
      if (source[at] === ']') {
        at += 1;
        return undefined;
      }
      return at;
    }
  };

  const problem = scanValue(0);
  if (problem !== undefined) return problem;

  // Trailing content after a complete value: `{} garbage`. The offset of the garbage, not the end.
  skipSpace();
  return at < source.length ? at : undefined;
}
