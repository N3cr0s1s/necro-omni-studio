/**
 * JSON, split into the pieces worth colouring.
 *
 * Issue #31 asks for a text editor with syntax highlighting. There is no highlighting library in this
 * repository and there will not be one: the renderer runs under a CSP that forbids fetching anything,
 * so a library would have to be vendored, and the whole of what is needed here is a JSON tokenizer —
 * which is small, exactly specifiable, and testable in a way a vendored blob is not.
 *
 * ## Tokens, not HTML
 *
 * This produces a list of spans and never a string of markup. Building HTML here would mean escaping
 * here, and an escaping bug in a highlighter is an injection bug in an editor that opens files from
 * disk. The component maps tokens to elements and React does the escaping.
 *
 * ## Tolerant on purpose
 *
 * A file being *edited* is malformed most of the time — every keystroke inside a string is a moment
 * when the quote is unclosed. So this never throws and never gives up: anything it cannot classify
 * comes back as `text`, and the highlighting degrades rather than vanishing.
 */

export type JsonTokenKind =
  /** A property name: a string immediately followed by a colon. */
  'key' | 'string' | 'number' | 'keyword' | 'punctuation' | 'text';

export interface JsonToken {
  readonly kind: JsonTokenKind;
  readonly text: string;
}

const PUNCTUATION = new Set(['{', '}', '[', ']', ':', ',']);
const KEYWORDS = new Set(['true', 'false', 'null']);

/**
 * Splits JSON source into tokens covering every character.
 *
 * The tokens concatenate back to the input exactly — whitespace included, as `text`. That is what lets
 * the highlighted layer sit *under* a textarea and line up with it character for character; a
 * tokenizer that dropped whitespace would drift by a space and put the caret in the wrong place.
 */
export function tokenizeJson(source: string): readonly JsonToken[] {
  const tokens: JsonToken[] = [];
  let at = 0;

  const push = (kind: JsonTokenKind, text: string): void => {
    if (text === '') return;
    const last = tokens[tokens.length - 1];
    // Runs of the same kind are merged, which keeps a file of mostly whitespace from becoming tens of
    // thousands of elements.
    if (last !== undefined && last.kind === kind)
      tokens[tokens.length - 1] = { kind, text: last.text + text };
    else tokens.push({ kind, text });
  };

  while (at < source.length) {
    const character = source[at]!;

    if (character === '"') {
      const string = readString(source, at);
      // A string followed by a colon is a property name, which is the distinction that makes a
      // manifest readable at a glance.
      push(isKeyAhead(source, at + string.length) ? 'key' : 'string', string);
      at += string.length;
      continue;
    }

    if (PUNCTUATION.has(character)) {
      push('punctuation', character);
      at += 1;
      continue;
    }

    const number = readNumber(source, at);
    if (number !== '') {
      push('number', number);
      at += number.length;
      continue;
    }

    const word = readWord(source, at);
    if (word !== '') {
      push(KEYWORDS.has(word) ? 'keyword' : 'text', word);
      at += word.length;
      continue;
    }

    push('text', character);
    at += 1;
  }

  return tokens;
}

/**
 * A string literal from its opening quote, including it and the closing one.
 *
 * An unterminated string runs to the end of the input rather than failing — which is what every string
 * is for the moment between typing the first quote and the second.
 */
function readString(source: string, from: number): string {
  let at = from + 1;
  while (at < source.length) {
    const character = source[at]!;
    // A backslash consumes whatever follows, so `\"` does not end the string and `\\` does not escape
    // the quote after it.
    if (character === '\\') at += 2;
    else if (character === '"') return source.slice(from, at + 1);
    else at += 1;
  }
  return source.slice(from);
}

/** Whether the next non-space character is a colon, which is what makes a string a key. */
function isKeyAhead(source: string, from: number): boolean {
  for (let at = from; at < source.length; at += 1) {
    const character = source[at]!;
    if (character === ':') return true;
    if (!/\s/.test(character)) return false;
  }
  return false;
}

/** A JSON number, or empty when there is not one here. Leading `-`, digits, fraction, exponent. */
function readNumber(source: string, from: number): string {
  const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(from));
  return match === null ? '' : match[0];
}

/** A run of letters, for `true`, `false`, `null` and anything else someone has typed. */
function readWord(source: string, from: number): string {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(from));
  return match === null ? '' : match[0];
}

/**
 * Where JSON stops parsing, as a line and a message.
 *
 * `JSON.parse` reports a character offset in a form that differs between engines, so the position is
 * recovered by parsing and, on failure, reading the offset out of the message — falling back to the
 * whole file when it cannot be found. A wrong line is worse than none, so an unrecognised message
 * yields no line at all rather than a guess.
 */
export interface JsonProblem {
  readonly message: string;
  /** 1-based, or `undefined` when the engine did not say where. */
  readonly line?: number;
}

export function jsonProblem(source: string): JsonProblem | undefined {
  if (source.trim() === '') return undefined;

  try {
    JSON.parse(source);
    return undefined;
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    const position = /position (\d+)/.exec(message);
    if (position === null) return { message };

    const offset = Number(position[1]);
    return { message, line: source.slice(0, offset).split('\n').length };
  }
}
