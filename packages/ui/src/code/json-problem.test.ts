import { describe, expect, it } from 'vitest';
import { jsonProblem } from './json-problem.js';

/**
 * Whether JSON parses, and where it stopped.
 *
 * The guard behind the editor's Save: saving invalid JSON over a manifest is how a project stops
 * loading, and this is what lets the editor see it before the file exists.
 */

describe('valid input', () => {
  it('reports nothing for a well-formed document', () => {
    expect(jsonProblem('{ "a": 1 }')).toBeUndefined();
  });

  it('reports nothing for an empty buffer', () => {
    // A new file is not a broken one, and refusing to save it would leave no way to create anything.
    expect(jsonProblem('   \n  ')).toBeUndefined();
  });
});

describe('invalid input', () => {
  it('says what the engine said', () => {
    expect(jsonProblem('{ "a": }')?.message).toMatch(/JSON/u);
  });

  it('converts the reported position to a line', () => {
    // A byte offset is a search through the whole file; a line is somewhere to look.
    expect(jsonProblem('{\n  "a": 1,\n  "b":\n}')?.line).toBeGreaterThan(1);
  });

  it('points at the line the problem is on, not at the first line', () => {
    const problem = jsonProblem('{\n  "a": 1,\n  "b": ,\n  "c": 2\n}');
    expect(problem?.line).toBe(3);
  });

  it('catches a truncated file, which is what a half-typed manifest is', () => {
    expect(jsonProblem('{ "a": ')).toBeDefined();
  });
});

describe('agreeing with the parser', () => {
  /*
   * The scanner exists to say *where*; it must never disagree with `JSON.parse` about *whether*. A
   * document this called broken and the engine accepted would block a save for no reason, and the
   * reverse would let a project-breaking file through.
   */
  const valid = [
    '{}',
    '[]',
    '{ "a": 1 }',
    '{"a":[1,2,{"b":null}],"c":true}',
    '  [ -1.5e10, 0, "x\\"y" ]  ',
    '"just a string"',
    '42',
    'null',
    '{ "nested": { "deep": [ { "deeper": [] } ] } }',
  ];

  for (const source of valid) {
    it(`accepts ${source.trim().slice(0, 40)}`, () => {
      expect(jsonProblem(source)).toBeUndefined();
    });
  }

  const broken = ['{ "a": }', '{ "a" 1 }', '[1,]', '{,}', '{ "a": 1 } trailing', '{ "a": 01 }', "{ 'a': 1 }"];

  for (const source of broken) {
    it(`rejects ${source}`, () => {
      expect(jsonProblem(source)).toBeDefined();
    });
  }
});

describe('where it says the problem is', () => {
  it('points at the line the offending token is on', () => {
    expect(jsonProblem('{\n  "a": 1,\n  "b": ,\n  "c": 2\n}')?.line).toBe(3);
  });

  it('gives a column, which is what lets the editor underline the token', () => {
    const problem = jsonProblem('{ "a": }');
    expect(problem?.column).toBe(8);
  });

  it('reports the opening quote of a string with no closing one', () => {
    // The missing quote is what the author has to fix; the newline it ran into is not.
    const problem = jsonProblem('{\n  "a": "unterminated\n}');
    expect(problem?.line).toBe(2);
  });

  it('points past a complete value at trailing content', () => {
    expect(jsonProblem('{} garbage')?.column).toBe(4);
  });

  it('survives a document nested past anything plausible', () => {
    // Run on every keystroke, so a pathological file must not exhaust the stack.
    const deep = `${'['.repeat(5000)}1${']'.repeat(5000)}`;
    expect(() => jsonProblem(deep)).not.toThrow();
  });
});
