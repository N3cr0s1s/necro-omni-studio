import { describe, expect, it } from 'vitest';
import { locationAt } from './json-location.js';
import { type SchemaShape, arrayOf, object, oneOf, shapeAt } from './schema.js';
import { acceptCompletion, completionsFor, describeShape } from './completion.js';

/**
 * What may be typed at a caret, per issue #31.
 *
 * Driven through `locationAt` from marked text rather than from hand-built locations: the two are only
 * useful together, and a completion test that invented its own location would keep passing after the
 * scanner started disagreeing with it.
 */

const SCHEMA: SchemaShape = object([
  { name: 'id', shape: { kind: 'string' }, required: true, doc: 'Identifier.' },
  { name: 'kind', shape: oneOf(['image', 'video', 'audio']), required: true, doc: 'What it makes.' },
  { name: 'loop', shape: { kind: 'boolean' } },
  { name: 'count', shape: { kind: 'number' } },
  {
    name: 'params',
    shape: arrayOf(
      object([
        { name: 'key', shape: { kind: 'string' } },
        { name: 'type', shape: oneOf(['int']) },
      ]),
    ),
  },
  { name: 'graph', shape: { kind: 'unknown' } },
]);

const at = (marked: string) => {
  const offset = marked.indexOf('|');
  return locationAt(marked.replace('|', ''), offset);
};
const labels = (marked: string) => completionsFor(SCHEMA, at(marked)).map((entry) => entry.label);

describe('completing a property name', () => {
  it('offers the object’s fields', () => {
    expect(labels('{ "|" }')).toEqual(['id', 'kind', 'loop', 'count', 'params', 'graph']);
  });

  it('is filtered by what has been typed', () => {
    expect(labels('{ "k|" }')).toEqual(['kind']);
  });

  it('ignores case, because manifests are lower-case and habits are not', () => {
    expect(labels('{ "K|" }')).toEqual(['kind']);
  });

  it('matches on a prefix rather than anywhere in the name', () => {
    // Substring matching sounds more helpful and is not: it puts `count` under `n`, and a list that
    // reorders unpredictably as you type is one people stop reading.
    expect(labels('{ "n|" }')).toEqual([]);
  });

  it('never offers a name the object already has', () => {
    // Accepting one would write a duplicate key: valid JSON, silently wrong.
    expect(labels('{ "id": "a", "|" }')).not.toContain('id');
  });

  it('keeps the order the schema declares rather than sorting', () => {
    // A manifest has a shape its author had in mind, and alphabetical order throws away the only
    // ordering anyone chose.
    expect(labels('{ "|" }')[0]).toBe('id');
  });

  it('offers the fields of a nested object inside an array', () => {
    expect(labels('{ "params": [ { "|" } ] }')).toEqual(['key', 'type']);
  });

  it('says which fields a manifest is incomplete without', () => {
    const required = completionsFor(SCHEMA, at('{ "|" }')).filter((entry) => entry.required === true);
    expect(required.map((entry) => entry.label)).toEqual(['id', 'kind']);
  });
});

describe('completing a value', () => {
  it('offers the values a constrained string allows', () => {
    expect(labels('{ "kind": "|" }')).toEqual(['image', 'video', 'audio']);
  });

  it('offers both booleans', () => {
    expect(labels('{ "loop": | }')).toEqual(['true', 'false']);
  });

  it('offers nothing for a free string, rather than something plausible', () => {
    expect(labels('{ "id": "|" }')).toEqual([]);
  });

  it('offers nothing for a number', () => {
    expect(labels('{ "count": | }')).toEqual([]);
  });

  it('offers nothing where the description says nothing', () => {
    // An empty popup is honest. A list of plausible-looking names that do not belong there is worse
    // than no feature, because it is trusted.
    expect(labels('{ "graph": { "|" } }')).toEqual([]);
  });
});

describe('what accepting one writes', () => {
  it('adds the quotes and the colon when the caret is not in a string', () => {
    // A completion that leaves you to type `": "` yourself has done the easy half.
    const source = '{  }';
    const location = locationAt(source, 2);
    const completion = completionsFor(SCHEMA, location).find((entry) => entry.label === 'kind')!;
    expect(acceptCompletion(source, location, completion).text).toBe('{ "kind":  }');
  });

  it('adds no quotes when the caret is already inside them', () => {
    const source = '{ "k" }';
    const location = locationAt(source, 4);
    const completion = completionsFor(SCHEMA, location)[0]!;
    expect(acceptCompletion(source, location, completion).text).toBe('{ "kind" }');
  });

  it('quotes a string value written outside quotes', () => {
    const source = '{ "kind":  }';
    const location = locationAt(source, 10);
    const completion = completionsFor(SCHEMA, location).find((entry) => entry.label === 'video')!;
    expect(acceptCompletion(source, location, completion).text).toBe('{ "kind": "video" }');
  });

  it('replaces the whole token, not only what is behind the caret', () => {
    // Otherwise `"imge"` completed at the `m` produces `"imagege"`.
    const source = '{ "kind": "imge" }';
    const location = locationAt(source, 13);
    const completion = completionsFor(SCHEMA, location).find((entry) => entry.label === 'image')!;
    expect(acceptCompletion(source, location, completion).text).toBe('{ "kind": "image" }');
  });

  it('closes a string the caret is inside that has no closing quote', () => {
    // Typing an opening quote leaves one, and this editor does not auto-close — so the unterminated
    // case is not an edge, it is what happens every time.
    const source = '{ "k';
    const location = locationAt(source, 4);
    const completion = completionsFor(SCHEMA, location)[0]!;
    expect(acceptCompletion(source, location, completion).text).toBe('{ "kind": ');
  });

  it('closes an unterminated value string too', () => {
    const source = '{ "kind": "vid';
    const location = locationAt(source, 14);
    const completion = completionsFor(SCHEMA, location).find((entry) => entry.label === 'video')!;
    expect(acceptCompletion(source, location, completion).text).toBe('{ "kind": "video"');
  });

  it('leaves the caret at the end of what it wrote', () => {
    const source = '{ "k" }';
    const location = locationAt(source, 4);
    const accepted = acceptCompletion(source, location, completionsFor(SCHEMA, location)[0]!);
    expect(accepted.text.slice(0, accepted.caret)).toBe('{ "kind');
  });
});

describe('the shape at a path', () => {
  it('walks objects and arrays', () => {
    expect(shapeAt(SCHEMA, ['params', 0, 'key'])).toEqual({ kind: 'string' });
  });

  it('is undefined for a name the description does not have', () => {
    expect(shapeAt(SCHEMA, ['nonesuch'])).toBeUndefined();
  });

  it('is undefined for an index into something that is not an array', () => {
    // The file's shape and the description have parted company, and guessing from there compounds it.
    expect(shapeAt(SCHEMA, ['id', 0])).toBeUndefined();
  });
});

describe('how a type is described', () => {
  it('names a small set of values outright', () => {
    expect(describeShape(oneOf(['a', 'b']))).toBe('a | b');
  });

  it('counts a large one, because a detail column that wraps stops being one', () => {
    expect(describeShape(oneOf(['a', 'b', 'c', 'd']))).toBe('one of 4');
  });

  it('marks an array by its element type', () => {
    expect(describeShape(arrayOf({ kind: 'number' }))).toBe('number[]');
  });
});

describe('with no description for the file', () => {
  it('offers nothing at all', () => {
    expect(completionsFor(undefined, at('{ "|" }'))).toEqual([]);
  });
});
