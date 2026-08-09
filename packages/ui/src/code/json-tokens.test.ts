import { describe, expect, it } from 'vitest';
import { type JsonToken, jsonProblem, tokenizeJson } from './json-tokens.js';

/**
 * JSON, split into the pieces worth colouring.
 *
 * Written rather than vendored: the renderer runs under a CSP that forbids fetching anything, and the
 * whole of what an editor needs here is a tokenizer — small, specifiable, and testable in a way a
 * vendored blob is not.
 */

const kinds = (source: string): string =>
  tokenizeJson(source)
    .map((token) => token.kind)
    .join(' ');
const of = (source: string, kind: JsonToken['kind']): string[] =>
  tokenizeJson(source)
    .filter((token) => token.kind === kind)
    .map((token) => token.text);

describe('covering the input', () => {
  it('concatenates back to exactly what went in', () => {
    // The property the whole design rests on: the highlighted layer sits *under* a textarea, so a
    // tokenizer that dropped a space would drift and put the caret in the wrong place.
    for (const source of [
      '{"a": 1}',
      '{\n  "a": [1, 2],\n  "b": null\n}\n',
      '   ',
      '',
      '{"unterminated: 1',
      'not json at all',
    ]) {
      expect(
        tokenizeJson(source)
          .map((token) => token.text)
          .join(''),
      ).toBe(source);
    }
  });

  it('never throws on a file mid-edit', () => {
    // Every string is unterminated for the moment between typing the first quote and the second.
    for (const source of ['{"', '{"a"', '{"a":', '[1,', '\\', '{"a": "b\\']) {
      expect(() => tokenizeJson(source)).not.toThrow();
    }
  });
});

describe('what it colours', () => {
  it('tells a key from a string by the colon that follows', () => {
    // The distinction that makes a manifest readable at a glance.
    expect(of('{"name": "Film grain"}', 'key')).toEqual(['"name"']);
    expect(of('{"name": "Film grain"}', 'string')).toEqual(['"Film grain"']);
  });

  it('sees a key even with space before the colon', () => {
    expect(of('{"name"   : 1}', 'key')).toEqual(['"name"']);
  });

  it('does not call a string in an array a key', () => {
    expect(of('["source", "mask"]', 'key')).toEqual([]);
    expect(of('["source", "mask"]', 'string')).toEqual(['"source"', '"mask"']);
  });

  it('reads numbers, including negative, fractional and exponent', () => {
    expect(of('[-1, 0.5, 2e10, 3E-4]', 'number')).toEqual(['-1', '0.5', '2e10', '3E-4']);
  });

  it('reads the three keywords and nothing else', () => {
    expect(of('[true, false, null, maybe]', 'keyword')).toEqual(['true', 'false', 'null']);
    // Joined, because runs of the same kind merge — the space before it is `text` too.
    expect(of('[true, maybe]', 'text').join('')).toContain('maybe');
  });

  it('reads punctuation', () => {
    expect(kinds('{}')).toBe('punctuation');
    expect(of('{"a": [1]}', 'punctuation').join('')).toBe('{:[]}');
  });
});

describe('strings with escapes', () => {
  it('does not end at an escaped quote', () => {
    expect(of('{"a": "say \\"hi\\""}', 'string')).toEqual(['"say \\"hi\\""']);
  });

  it('does not treat the quote after an escaped backslash as escaped', () => {
    // `"a\\"` is a complete string whose content is one backslash.
    expect(of('["a\\\\", 1]', 'string')).toEqual(['"a\\\\"']);
  });

  it('runs an unterminated string to the end rather than failing', () => {
    expect(of('{"a": "unfinished', 'string')).toEqual(['"unfinished']);
  });
});

describe('merging', () => {
  it('joins runs of the same kind, so whitespace is not a token per character', () => {
    // A file of mostly whitespace would otherwise become tens of thousands of elements.
    const tokens = tokenizeJson('{\n\n\n  "a": 1\n}');
    expect(tokens.filter((token) => token.kind === 'text').length).toBeLessThan(4);
  });
});

describe('where it stops parsing', () => {
  it('says nothing about valid JSON', () => {
    expect(jsonProblem('{"a": 1}')).toBeUndefined();
  });

  it('says nothing about an empty file, which is not an error to be told about', () => {
    expect(jsonProblem('   ')).toBeUndefined();
  });

  it('names the line', () => {
    const problem = jsonProblem('{\n  "a": 1,\n  "b" 2\n}');
    expect(problem?.line).toBe(3);
  });

  it('gives the message even when the engine did not say where', () => {
    // A wrong line is worse than none, so an unrecognised message yields no line rather than a guess.
    const problem = jsonProblem('{');
    expect(problem?.message.length).toBeGreaterThan(0);
  });
});
