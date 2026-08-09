import { describe, expect, it } from 'vitest';
import { locationAt } from './json-location.js';

/**
 * Where a caret is inside JSON source, per issue #31.
 *
 * The caret is written as `|` in each fixture and stripped before the call, so every case reads as the
 * text the user is actually looking at. An offset argument would make these unreadable and would hide
 * off-by-ones in the test rather than in the code.
 */
const at = (marked: string) => {
  const offset = marked.indexOf('|');
  if (offset === -1) throw new Error('the fixture has no caret');
  return locationAt(marked.replace('|', ''), offset);
};

describe('naming a property', () => {
  it('is a key slot at the root', () => {
    const found = at('{ "ki|" }');
    expect(found.slot).toBe('key');
    expect(found.path).toEqual([]);
    expect(found.prefix).toBe('ki');
  });

  it('is a key slot inside a nested object', () => {
    const found = at('{ "size": { "wid|" } }');
    expect(found.slot).toBe('key');
    expect(found.path).toEqual(['size']);
  });

  it('is a key slot on an empty object with the caret between the braces', () => {
    // No token at all: the popup has to open on an empty object, which is precisely when someone has
    // no idea what goes there.
    const found = at('{ "size": {|} }');
    expect(found.slot).toBe('key');
    expect(found.path).toEqual(['size']);
    expect(found.prefix).toBe('');
  });

  it('reports no quotes when the caret is not in a string', () => {
    // Which decides whether accepting a completion has to write the quotes itself.
    expect(at('{ "size": {|} }').quoted).toBe(false);
    expect(at('{ "ki|" }').quoted).toBe(true);
  });
});

describe('writing a value', () => {
  it('is a value slot once the colon is passed', () => {
    const found = at('{ "kind": "im|" }');
    expect(found.slot).toBe('value');
    // The key joins the path, so a schema is looked up the same way for both slots.
    expect(found.path).toEqual(['kind']);
  });

  it('is a value slot with the caret after the colon and no token yet', () => {
    const found = at('{ "kind": | }');
    expect(found.slot).toBe('value');
    expect(found.path).toEqual(['kind']);
  });

  it('completes a bare word, rather than waiting for a quote', () => {
    const found = at('{ "loop": tru| }');
    expect(found.slot).toBe('value');
    expect(found.prefix).toBe('tru');
    expect(found.quoted).toBe(false);
  });
});

describe('arrays', () => {
  it('counts the element the caret is in', () => {
    const found = at('{ "params": [ {}, { "ty|" } ] }');
    expect(found.path).toEqual(['params', 1]);
    expect(found.slot).toBe('key');
  });

  it('starts at the first element', () => {
    expect(at('{ "params": [ { "ty|" } ] }').path).toEqual(['params', 0]);
  });

  it('is a value slot directly inside an array, which holds no names', () => {
    expect(at('{ "tags": [ "a|" ] }').slot).toBe('value');
  });
});

describe('what an accepted completion replaces', () => {
  it('is the whole token, not only what is behind the caret', () => {
    // Otherwise completing in the middle of a word leaves its tail behind: `"im|ge"` accepting `image`
    // would produce `"imagege"`.
    const found = at('{ "kind": "im|ge" }');
    expect(found.replaceFrom).toBe(11);
    expect(found.replaceTo).toBe(15);
    expect(found.prefix).toBe('im');
  });

  it('is an empty span at the caret when there is no token', () => {
    const found = at('{ "kind": | }');
    expect(found.replaceFrom).toBe(found.replaceTo);
  });

  it('does not include the quotes, so accepting does not double them', () => {
    const found = at('{ "ki|" }');
    expect(found.replaceFrom).toBe(3);
    expect(found.replaceTo).toBe(5);
  });
});

describe('what is already written', () => {
  it('lists the object’s other property names', () => {
    expect(at('{ "id": "a", "kind": "b", "n|" }').siblings).toEqual(['id', 'kind']);
  });

  it('counts names written below the caret too', () => {
    // Inserting a key halfway down an object must not offer one that already appears further on.
    expect(at('{ "id": "a", "n|", "kind": "b" }').siblings).toEqual(['id', 'kind']);
  });

  it('never includes the name being typed', () => {
    // A key offered back to itself is the one suggestion guaranteed to be useless.
    expect(at('{ "kind|": "b" }').siblings).toEqual([]);
  });

  it('is only the enclosing object’s, not an outer one’s', () => {
    expect(at('{ "id": "a", "size": { "w|" } }').siblings).toEqual([]);
  });

  it('is empty inside an array', () => {
    expect(at('{ "tags": [ "a|" ] }').siblings).toEqual([]);
  });
});

describe('surviving text that is not valid JSON yet', () => {
  it('locates inside an object that was never closed', () => {
    // The text is invalid by definition while it is being typed, which is exactly when completion is
    // wanted — `JSON.parse` reports failure at the worst possible moment.
    const found = at('{ "size": { "wid|');
    expect(found.slot).toBe('key');
    expect(found.path).toEqual(['size']);
  });

  it('does not let an unterminated string swallow the rest of the file', () => {
    // Without a newline ending the string, everything after a missing quote is one giant token with
    // the caret buried inside it, and nothing below a typo would ever complete again. The location
    // that follows is still confused about the *structure* — no comma was ever passed, so this reads
    // as the value of `name` — but the text below the typo is being scanned, which is the difference
    // between degraded and dead.
    const found = at('{\n  "name": "unclosed\n  "ki|"\n}');
    expect(found.prefix).toBe('ki');
    expect(found.quoted).toBe(true);
  });

  it('ignores a closer that matches nothing', () => {
    expect(() => at('} } { "a|"')).not.toThrow();
  });

  it('answers on an empty document', () => {
    const found = at('|');
    expect(found.slot).toBe('value');
    expect(found.path).toEqual([]);
    expect(found.prefix).toBe('');
  });

  it('handles an escaped quote inside a string without losing the structure', () => {
    const found = at('{ "title": "a \\" b", "ki|" }');
    expect(found.slot).toBe('key');
    expect(found.siblings).toEqual(['title']);
  });
});

describe('whether the string the caret is in is closed', () => {
  it('is closed when it has its quote', () => {
    expect(at('{ "ki|" }').closed).toBe(true);
  });

  it('is open while it is still being typed', () => {
    expect(at('{ "ki|').closed).toBe(false);
  });

  it('finds the caret at the end of an unterminated string', () => {
    // Getting this wrong meant a caret at the end of `"sha` counted as being nowhere, and the editor
    // offered to insert a whole new property beside it.
    const found = at('{\n  "sha|\n}');
    expect(found.prefix).toBe('sha');
    expect(found.slot).toBe('key');
  });
});

describe('a caret at the very end of the file', () => {
  it('still reports where it is', () => {
    const found = at('{ "kind": "image" }|');
    expect(found.slot).toBe('value');
    expect(found.path).toEqual([]);
  });
});
