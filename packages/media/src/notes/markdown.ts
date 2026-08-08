/**
 * Markdown, as a value.
 *
 * The spec asks for one thing in §4 — "a markdownt a browser megjeleníti" — and it is the only reason
 * `notes/` is a reserved folder: a project holds references, a shot list, a client's note, and the
 * browser showed the filename and nothing else.
 *
 * ## Why a parser and not a library
 *
 * Every markdown library produces an HTML **string**, which a renderer can only display through
 * `dangerouslySetInnerHTML`. The content here is a file in the user's project folder, which arrives
 * from a client, a download, a generator — and injecting it as markup would make a note a way to put
 * arbitrary elements into the application's own DOM. Parsing to a structure instead means the renderer
 * emits React elements and there is no path from a file's bytes to markup at all. The subset below is
 * what notes actually contain; anything unrecognised degrades to a paragraph of its own literal text,
 * which is the honest failure for a document format.
 *
 * Deliberately not CommonMark. Reference links, HTML blocks, setext headings, nested blockquotes and
 * loose lists are all absent, and adding one is a case here rather than a change of approach.
 */

/** A block-level element. The renderer switches over `kind` and nothing else. */
export type MarkdownBlock =
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly spans: readonly MarkdownSpan[];
    }
  | { readonly kind: 'paragraph'; readonly spans: readonly MarkdownSpan[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly MarkdownSpan[])[] }
  | { readonly kind: 'quote'; readonly spans: readonly MarkdownSpan[] }
  /** Fenced or indented. `language` is whatever followed the fence, unvalidated. */
  | { readonly kind: 'code'; readonly text: string; readonly language?: string }
  | { readonly kind: 'rule' };

/** An inline run. Nesting is deliberately one level deep: `**a _b_**` renders as bold `a _b_`. */
export type MarkdownSpan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'emphasis'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

const HEADING = /^(#{1,6})\s+(.*)$/u;
const BULLET = /^\s*[-*+]\s+(.*)$/u;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const FENCE = /^\s*(```|~~~)\s*(\S*)\s*$/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;

/**
 * Parses a document into blocks.
 *
 * Line-based rather than a character stream: markdown's block structure *is* line-based, and a
 * tokenizer would be a great deal more code for a subset this size. A fence is the one construct that
 * suspends the rules, which is why it is checked before everything else — a `# heading` inside a code
 * block is a heading in the code, not a heading.
 */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  // Normalised first: a file written on Windows would otherwise leave a carriage return at the end of
  // every heading, which shows up as a stray glyph rather than as anything diagnosable.
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const closing = fence[1]!;
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end of the file, which is what every renderer does and is
      // kinder than dropping the rest of the document.
      while (index < lines.length && !(lines[index] ?? '').trimEnd().startsWith(closing)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      const language = fence[2] ?? '';
      blocks.push({
        kind: 'code',
        text: body.join('\n'),
        ...(language !== '' ? { language } : {}),
      });
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        spans: parseSpans(heading[2] ?? ''),
      });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index] ?? '');
        if (quoted === null) break;
        body.push(quoted[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', spans: parseSpans(body.join(' ')) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: (readonly MarkdownSpan[])[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const matched = ordered ? ORDERED.exec(current) : BULLET.exec(current);
        // A list ends where its own marker stops. Switching marker starts a *new* list rather than
        // continuing this one, which is what keeps an ordered list from absorbing the bullets under it.
        if (matched === null) break;
        items.push(parseSpans(matched[1] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // A paragraph runs until a blank line or until any other construct starts, so a heading directly
    // under a line of prose is still a heading.
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '' || startsBlock(current)) break;
      body.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseSpans(body.join(' ')) });
  }

  return blocks;
}

function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    FENCE.test(line) ||
    RULE.test(line)
  );
}

/**
 * Inline runs, in one pass.
 *
 * Code first, and non-negotiably: everything else must not be interpreted inside a backtick span, or
 * `` `**bold**` `` would render bold instead of showing what it says. That is the one rule a naive
 * sequence of `replace` calls always gets wrong.
 */
const INLINE = /(`[^`]+`)|(\[[^\]]*\]\([^)\s]+\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)/u;

export function parseSpans(source: string): readonly MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let rest = source;

  while (rest !== '') {
    const match = INLINE.exec(rest);
    if (match === null || match.index === undefined) break;

    if (match.index > 0) spans.push({ kind: 'text', text: rest.slice(0, match.index) });
    const token = match[0];

    if (match[1] !== undefined) {
      spans.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (match[2] !== undefined) {
      const split = token.indexOf('](');
      spans.push({
        kind: 'link',
        text: token.slice(1, split),
        href: token.slice(split + 2, -1),
      });
    } else if (match[3] !== undefined) {
      spans.push({ kind: 'strong', text: token.slice(2, -2) });
    } else {
      spans.push({ kind: 'emphasis', text: token.slice(1, -1) });
    }

    rest = rest.slice(match.index + token.length);
  }

  if (rest !== '') spans.push({ kind: 'text', text: rest });
  // Never an empty list for non-empty input: a caller rendering `spans.map(...)` would draw nothing
  // and the line would read as missing rather than as blank.
  return spans.length === 0 && source !== '' ? [{ kind: 'text', text: source }] : spans;
}

/** Whether a project-relative path is a note this can show. */
export function isMarkdown(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path);
}

/**
 * The first heading, or the first line of prose.
 *
 * A note's *title*, which is almost never its filename — `notes/2026-02-11.md` is dated, not named.
 * Used where there is room for one line and not for a document.
 */
export function markdownTitle(blocks: readonly MarkdownBlock[]): string | undefined {
  for (const block of blocks) {
    if (block.kind === 'heading' || block.kind === 'paragraph') {
      const text = plainText(block.spans).trim();
      if (text !== '') return text;
    }
  }
  return undefined;
}

/** The text of a run of spans, with the markup dropped. */
export function plainText(spans: readonly MarkdownSpan[]): string {
  return spans.map((span) => span.text).join('');
}
