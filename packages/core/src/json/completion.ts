import type { JsonLocation } from './json-location.js';
import { type SchemaShape, shapeAt } from './schema.js';

/**
 * What may be typed at a caret, and what accepting it does to the text.
 *
 * Issue #31. Kept pure and away from the editor: everything here is text in, text out, which is what
 * makes the awkward cases — a caret already inside quotes, a value that is a number rather than a
 * string, a key that is already written further down — checkable without rendering anything.
 */

export interface Completion {
  /** What the list shows and what filtering matches against. */
  readonly label: string;
  /** The type, shown greyed beside the label. */
  readonly detail?: string;
  /** One line saying what it is for. */
  readonly doc?: string;
  readonly kind: 'property' | 'value';
  /** Whether the schema says a manifest is incomplete without it. */
  readonly required?: boolean;
  /**
   * The exact text to put in place of the location's replace span.
   *
   * Computed here rather than by the editor because it depends on what is *already* on screen — a
   * caret inside quotes must not add another pair, and one outside must add both. Leaving that to the
   * caller is how an editor ends up writing `""kind""`.
   */
  readonly insert: string;
}

/**
 * What belongs at a caret.
 *
 * Ordered as the schema lists its fields rather than alphabetically: a manifest has a shape its author
 * had in mind — identity, then behaviour, then presentation — and sorting that into alphabetical order
 * throws away the only ordering anyone chose.
 */
export function completionsFor(root: SchemaShape | undefined, location: JsonLocation): readonly Completion[] {
  if (root === undefined) return [];

  const shape = shapeAt(root, location.path);
  if (shape === undefined) return [];

  const offered = location.slot === 'key' ? properties(shape, location) : values(shape, location);

  // Matched on what has been typed, case-insensitively and by prefix. Substring matching sounds more
  // helpful and is not: it puts `resolution` under `l`, and a list that reorders itself unpredictably
  // as you type is one people stop reading.
  const typed = location.prefix.toLowerCase();
  return offered.filter((completion) => completion.label.toLowerCase().startsWith(typed));
}

function properties(shape: SchemaShape, location: JsonLocation): readonly Completion[] {
  if (shape.kind !== 'object') return [];

  const written = new Set(location.siblings);

  return (
    shape.fields
      // A name the object already has is not a suggestion; accepting it would write a duplicate key,
      // which is valid JSON and silently wrong.
      .filter((field) => !written.has(field.name))
      .map((field) => ({
        label: field.name,
        detail: describeShape(field.shape),
        ...(field.doc !== undefined ? { doc: field.doc } : {}),
        kind: 'property' as const,
        ...(field.required === true ? { required: true } : {}),
        // Three cases, and the middle one is the common one. Outside quotes the whole entry is
        // written. Inside an *unterminated* string — what you have the moment you type an opening
        // quote — the name closes it and brings the colon. Inside a closed string only the name goes
        // in, because the rest is already there.
        insert: !location.quoted ? `"${field.name}": ` : location.closed ? field.name : `${field.name}": `,
      }))
  );
}

function values(shape: SchemaShape, location: JsonLocation): readonly Completion[] {
  if (shape.kind === 'boolean') {
    return ['true', 'false'].map((literal) => ({
      label: literal,
      detail: 'boolean',
      kind: 'value' as const,
      insert: literal,
    }));
  }

  if (shape.kind === 'string' && shape.values !== undefined) {
    return shape.values.map((value) => ({
      label: value,
      detail: 'string',
      kind: 'value' as const,
      insert: !location.quoted ? `"${value}"` : location.closed ? value : `${value}"`,
    }));
  }

  return [];
}

/** The type as a reader wants to see it: a name, or the set of values when there is one. */
export function describeShape(shape: SchemaShape): string {
  switch (shape.kind) {
    case 'object':
      return 'object';
    case 'array':
      return `${describeShape(shape.of)}[]`;
    case 'string':
      // Named rather than listed past a handful: a detail column that wraps to three lines stops being
      // a detail column.
      return shape.values === undefined
        ? 'string'
        : shape.values.length <= 3
          ? shape.values.join(' | ')
          : `one of ${shape.values.length}`;
    case 'unknown':
      return 'any';
    default:
      return shape.kind;
  }
}

/** Text and caret after accepting a completion. */
export interface Accepted {
  readonly text: string;
  /** Where the caret lands, which is always the end of what was inserted. */
  readonly caret: number;
}

/**
 * Applies a completion to the source.
 *
 * Replaces the *whole* token under the caret, not just the part behind it — completing in the middle
 * of `"imge"` must produce `"image"` rather than `"imagege"`.
 */
export function acceptCompletion(source: string, location: JsonLocation, completion: Completion): Accepted {
  const text = source.slice(0, location.replaceFrom) + completion.insert + source.slice(location.replaceTo);
  return { text, caret: location.replaceFrom + completion.insert.length };
}
