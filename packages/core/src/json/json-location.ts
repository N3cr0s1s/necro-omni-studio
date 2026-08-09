/**
 * Where a caret is inside JSON source, structurally.
 *
 * Issue #31 asks for completion driven by a schema. Everything else in that feature depends on this
 * one question: given half-written text and an offset, *what is being typed* — a property name or a
 * value, inside which object, under which key. A schema cannot say what belongs here until something
 * says where here is.
 *
 * ## Why this is not the highlighter's tokenizer
 *
 * `tokenizeJson` colours; this one locates. The tokenizer merges runs of a kind and carries no
 * offsets, both of which are right for painting a layer and useless for finding a caret — and giving
 * it offsets would slow the paint path for every keystroke to serve a popup that is usually closed.
 * The overlap is reading a quoted string, which is a dozen lines.
 *
 * ## Why it is a scanner rather than a parse
 *
 * The text is, by definition, invalid while it is being typed: `{ "ki` is not JSON and never will be
 * until the user finishes. `JSON.parse` reports failure at exactly the moment completion is most
 * wanted. A scanner that tracks nesting and never fails is the only thing that answers here.
 */

/** A step in a path: a property name, or an index into an array. */
export type JsonPathStep = string | number;

/** What is being typed at the caret. */
export type JsonSlot = 'key' | 'value';

export interface JsonLocation {
  /**
   * Where the caret is, from the document root.
   *
   * For a key, the path of the object it will go into: `{ "ki| }` at the root is `[]`. For a value,
   * the path *including* the key being valued: `{ "kind": "im| }` is `['kind']`. That is what lets a
   * schema be looked up by the same path in both cases.
   */
  readonly path: readonly JsonPathStep[];
  readonly slot: JsonSlot;
  /** What has been typed of the token under the caret, unquoted. Empty when nothing has. */
  readonly prefix: string;
  /** Whether the caret sits inside a string literal, which decides whether a completion adds quotes. */
  readonly quoted: boolean;
  /**
   * Whether that string has a closing quote.
   *
   * Typing an opening quote leaves one that does not, and this editor does not auto-close — so the
   * unterminated case is not an edge, it is what happens every time. A completion accepted there has
   * to close the string itself, or the user is left to notice and do it.
   */
  readonly closed: boolean;
  /** The span an accepted completion replaces — the whole token under the caret, not just the prefix. */
  readonly replaceFrom: number;
  readonly replaceTo: number;
  /** Property names already written in the object the caret is in, minus the one being typed. */
  readonly siblings: readonly string[];
}

interface Frame {
  kind: 'object' | 'array';
  /** The key whose value is being read, once a colon has been seen. */
  key: string | undefined;
  /** How many elements of an array have been completed. */
  index: number;
  /** Property names already closed in this object. */
  keys: string[];
  /** Whether the colon after the current key has been passed. */
  valuing: boolean;
}

const WORD = /[A-Za-z0-9_.+-]/u;

/**
 * The scanner's state at the moment it reached the caret.
 *
 * Taken as a copy, because the scan does not stop there. It keeps going so that property names written
 * *below* the caret are still counted as siblings — inserting a key halfway down an object should not
 * offer one that already appears further on. The frames are copied so the path reflects where the
 * caret was, while `keys` stays the live array so it keeps filling as the rest of the object is read.
 */
interface Snapshot {
  readonly frames: readonly Omit<Frame, 'keys'>[];
  readonly enclosing: Frame | undefined;
}

export function locationAt(source: string, offset: number): JsonLocation {
  const caret = Math.max(0, Math.min(offset, source.length));
  const stack: Frame[] = [];

  /** The token the caret is inside, if any. */
  let token: { from: number; to: number; quoted: boolean; closed: boolean } | undefined;
  let snapshot: Snapshot | undefined;

  const reached = (): void => {
    if (snapshot !== undefined) return;
    snapshot = {
      frames: stack.map((frame) => ({ ...frame })),
      enclosing: stack[stack.length - 1],
    };
  };

  let at = 0;
  while (at < source.length) {
    if (at >= caret) reached();

    const character = source[at]!;
    const frame = stack[stack.length - 1];

    if (character === '"') {
      const string = readString(source, at);
      const end = string.end;
      /*
       * Where the text of the string stops.
       *
       * A closed string ends before its closing quote, and a caret *after* that quote is between
       * tokens rather than in one. An unterminated string has no closing quote to be before — and an
       * unterminated string is what you have every time you type an opening one, so getting this wrong
       * meant a caret at the end of `"sha` counted as being nowhere and the editor offered to insert a
       * whole new property beside it.
       */
      const content = string.terminated ? end - 1 : end;
      const inside = caret > at && caret <= content;
      // A string is a property name when it sits in an object and no colon has been passed for the
      // entry — the same rule the highlighter uses, arrived at from the other direction.
      const isKey = frame?.kind === 'object' && !frame.valuing;

      if (inside) {
        reached();
        token = { from: at + 1, to: Math.max(at + 1, content), quoted: true, closed: string.terminated };
      }

      if (isKey && frame !== undefined) {
        frame.key = source.slice(at + 1, Math.max(at + 1, content));
        // Everything except the name being typed. A key offered back to itself is the one suggestion
        // guaranteed to be useless, and excluding it here is simpler than removing it by name later —
        // where two properties sharing a name would make "which one" a real question.
        if (!inside) frame.keys.push(frame.key);
      }

      at = end;
      continue;
    }

    if (character === '{' || character === '[') {
      stack.push({
        kind: character === '{' ? 'object' : 'array',
        key: undefined,
        index: 0,
        keys: [],
        valuing: false,
      });
      at += 1;
      continue;
    }

    if (character === '}' || character === ']') {
      // A stray closer on unfinished text is ignored rather than throwing: the whole point of a
      // scanner here is that it survives whatever half-written state the file is in.
      stack.pop();
      at += 1;
      continue;
    }

    if (character === ':') {
      if (frame !== undefined) frame.valuing = true;
      at += 1;
      continue;
    }

    if (character === ',') {
      if (frame?.kind === 'object') {
        frame.valuing = false;
        frame.key = undefined;
      } else if (frame !== undefined) frame.index += 1;
      at += 1;
      continue;
    }

    if (WORD.test(character)) {
      let end = at;
      while (end < source.length && WORD.test(source[end]!)) end += 1;
      // A bare word — `tru`, a number, an unquoted key someone is midway through. Completed against,
      // because refusing to suggest anything until a quote is typed is what makes a feature feel broken.
      if (caret > at && caret <= end) {
        reached();
        token = { from: at, to: end, quoted: false, closed: false };
      }
      at = end;
      continue;
    }

    at += 1;
  }

  // A caret at the very end of the file never met the check inside the loop.
  reached();

  return describe(source, snapshot ?? { frames: [], enclosing: undefined }, caret, token);
}

function describe(
  source: string,
  snapshot: Snapshot,
  caret: number,
  token: { from: number; to: number; quoted: boolean; closed: boolean } | undefined,
): JsonLocation {
  const frame = snapshot.frames[snapshot.frames.length - 1];

  const path: JsonPathStep[] = [];
  for (const entry of snapshot.frames) {
    if (entry.kind === 'array') path.push(entry.index);
    // An object's key joins the path only once its *value* is what is being read; while the name
    // itself is being typed the caret is still in the object, not under the key.
    else if (entry.valuing && entry.key !== undefined) path.push(entry.key);
  }

  /*
   * Which of the two is being typed.
   *
   * An object that has not passed a colon is naming a property; anything else is a value. An array
   * only ever holds values, and the root — no frame at all — is a value too: an empty file's first
   * token is the document itself.
   */
  const slot: JsonSlot = frame?.kind === 'object' && !frame.valuing ? 'key' : 'value';

  return {
    path,
    slot,
    // What has been typed *so far* — the token up to the caret, not the whole of it, so a caret in the
    // middle of a word completes on what is behind it rather than on text the user has not reached.
    prefix: token === undefined ? '' : source.slice(token.from, caret),
    quoted: token?.quoted ?? false,
    closed: token?.closed ?? false,
    replaceFrom: token?.from ?? caret,
    replaceTo: token?.to ?? caret,
    siblings: frame?.kind === 'object' ? (snapshot.enclosing?.keys ?? []) : [],
  };
}

/**
 * Where a string stops, and whether it was closed.
 *
 * `terminated` matters because half-written text is the normal case here: the caller has to know
 * whether the last character is a closing quote or simply where the user has typed to.
 */
function readString(source: string, start: number): { readonly end: number; readonly terminated: boolean } {
  let at = start + 1;
  while (at < source.length) {
    const character = source[at]!;
    if (character === '\\') {
      at += 2;
      continue;
    }
    if (character === '"') return { end: at + 1, terminated: true };
    // A newline ends an unterminated string. Without this a missing quote swallows the rest of the
    // file and every completion below it is answered against the wrong object.
    if (character === '\n') return { end: at, terminated: false };
    at += 1;
  }
  return { end: source.length, terminated: false };
}
