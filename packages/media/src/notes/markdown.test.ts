import { describe, expect, it } from 'vitest';
import {
  type MarkdownBlock,
  isMarkdown,
  markdownTitle,
  parseMarkdown,
  parseSpans,
  plainText,
} from './markdown.js';

/**
 * Markdown as a value.
 *
 * Parsed rather than converted to HTML, and the reason is the same one that decides most of what is
 * asserted below: a note is a file in the user's project folder, arriving from a client or a download,
 * and a renderer taking an HTML string could only display it through `dangerouslySetInnerHTML`. A
 * structure means there is no path from a file's bytes to markup at all.
 */

const kinds = (blocks: readonly MarkdownBlock[]) => blocks.map((block) => block.kind);

const textOf = (block: MarkdownBlock | undefined): string =>
  block !== undefined && 'spans' in block ? plainText(block.spans) : '';

describe('block structure', () => {
  it('reads headings by their depth', () => {
    const blocks = parseMarkdown('# One\n\n### Three');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 3 });
  });

  it('joins a wrapped paragraph into one block', () => {
    // A note is written in a text editor with soft wrapping off; a hard-wrapped sentence is still one
    // sentence and must not render as three.
    const blocks = parseMarkdown('the client wants\nthe logo bigger\nby friday');
    expect(kinds(blocks)).toEqual(['paragraph']);
    expect(textOf(blocks[0])).toBe('the client wants the logo bigger by friday');
  });

  it('ends a paragraph where another construct begins, not only at a blank line', () => {
    const blocks = parseMarkdown('some prose\n# and a heading');
    expect(kinds(blocks)).toEqual(['paragraph', 'heading']);
  });

  it('collects a bullet list', () => {
    const blocks = parseMarkdown('- one\n- two\n* three');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[0]).toHaveProperty('items.length', 3);
  });

  it('keeps an ordered list from absorbing the bullets under it', () => {
    // Different markers are different lists. Merging them would renumber somebody's shot list.
    const blocks = parseMarkdown('1. first\n2. second\n- a bullet');
    expect(kinds(blocks)).toEqual(['list', 'list']);
    expect(blocks[0]).toMatchObject({ ordered: true });
    expect(blocks[1]).toMatchObject({ ordered: false });
  });

  it('reads a quote across its lines', () => {
    const blocks = parseMarkdown('> they said\n> make it pop');
    expect(blocks[0]).toMatchObject({ kind: 'quote' });
    expect(textOf(blocks[0])).toBe('they said make it pop');
  });

  it('reads a rule', () => {
    expect(kinds(parseMarkdown('a\n\n---\n\nb'))).toEqual(['paragraph', 'rule', 'paragraph']);
  });

  it('drops blank lines rather than emitting empty paragraphs', () => {
    expect(kinds(parseMarkdown('\n\n\na\n\n\n\nb\n\n'))).toEqual(['paragraph', 'paragraph']);
  });

  it('says nothing about an empty document', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });
});

describe('code blocks', () => {
  it('keeps a fenced block verbatim, including its blank lines', () => {
    const blocks = parseMarkdown('```\nline one\n\nline three\n```');
    expect(blocks[0]).toEqual({ kind: 'code', text: 'line one\n\nline three' });
  });

  it('carries the language the fence named', () => {
    expect(parseMarkdown('```glsl\nvoid main() {}\n```')[0]).toMatchObject({ language: 'glsl' });
  });

  it('suspends every other rule inside itself', () => {
    // A `#` in a shader is a preprocessor directive, not a heading — and this is the whole reason a
    // fence is checked before anything else.
    const blocks = parseMarkdown('```\n# not a heading\n- not a list\n```');
    expect(kinds(blocks)).toEqual(['code']);
    expect(blocks[0]).toMatchObject({ text: '# not a heading\n- not a list' });
  });

  it('runs an unterminated fence to the end rather than dropping the rest', () => {
    const blocks = parseMarkdown('intro\n\n```\nforgot to close');
    expect(kinds(blocks)).toEqual(['paragraph', 'code']);
    expect(blocks[1]).toMatchObject({ text: 'forgot to close' });
  });

  it('closes on the fence it was opened with', () => {
    expect(parseMarkdown('~~~\nbody\n~~~')[0]).toMatchObject({ kind: 'code', text: 'body' });
  });
});

describe('inline runs', () => {
  it('reads bold, italic, code and links', () => {
    expect(parseSpans('**a** _b_ `c` [d](https://e)')).toEqual([
      { kind: 'strong', text: 'a' },
      { kind: 'text', text: ' ' },
      { kind: 'emphasis', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'd', href: 'https://e' },
    ]);
  });

  it('does not interpret markup inside a code span', () => {
    // The rule a sequence of `replace` calls always gets wrong, and the reason code is matched first.
    expect(parseSpans('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }]);
  });

  it('keeps surrounding text', () => {
    expect(parseSpans('before **middle** after')).toEqual([
      { kind: 'text', text: 'before ' },
      { kind: 'strong', text: 'middle' },
      { kind: 'text', text: ' after' },
    ]);
  });

  it('leaves an unmatched marker as the literal text it is', () => {
    // Prose about a filename like `take_02` must not turn half a sentence italic.
    expect(parseSpans('a * lonely star')).toEqual([{ kind: 'text', text: 'a * lonely star' }]);
  });

  it('never returns nothing for text that is there', () => {
    // A caller rendering `spans.map(...)` would draw an empty line, and the note would read as
    // missing rather than as plain.
    expect(parseSpans('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
  });

  it('is empty only for empty input', () => {
    expect(parseSpans('')).toEqual([]);
  });
});

describe('line endings', () => {
  it('reads a file written on Windows', () => {
    // Otherwise every heading keeps a carriage return, which renders as a stray glyph rather than as
    // anything a user could diagnose.
    const blocks = parseMarkdown('# Title\r\n\r\nbody\r\n');
    expect(textOf(blocks[0])).toBe('Title');
    expect(textOf(blocks[1])).toBe('body');
  });
});

describe('naming a note', () => {
  it('takes the first heading, because a filename is usually a date', () => {
    expect(markdownTitle(parseMarkdown('# Grade notes\n\nbody'))).toBe('Grade notes');
  });

  it('falls back to the first prose when there is no heading', () => {
    expect(markdownTitle(parseMarkdown('just a line of prose'))).toBe('just a line of prose');
  });

  it('drops the markup, so a title is a title', () => {
    expect(markdownTitle(parseMarkdown('# **Bold** title'))).toBe('Bold title');
  });

  it('is nothing for a note with neither', () => {
    expect(markdownTitle(parseMarkdown('```\ncode only\n```'))).toBeUndefined();
  });
});

describe('recognising a note', () => {
  it('accepts both extensions, in any case', () => {
    expect(isMarkdown('notes/a.md')).toBe(true);
    expect(isMarkdown('notes/B.MARKDOWN')).toBe(true);
  });

  it('refuses anything else, including a name that merely contains one', () => {
    expect(isMarkdown('media/take.mp4')).toBe(false);
    expect(isMarkdown('notes/md')).toBe(false);
    expect(isMarkdown('notes/a.md.bak')).toBe(false);
  });
});
