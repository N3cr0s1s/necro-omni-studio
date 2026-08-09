import type { JsonPathStep } from './json-location.js';

/**
 * What a JSON file is allowed to contain, described well enough to complete against.
 *
 * Issue #31 asks for completion "based on a JSON schema". This is deliberately *not* JSON Schema the
 * specification: that language exists to validate, and validation is already done — by the parsers in
 * `serialization/`, which report what is wrong with a file and where. Shipping a second, structurally
 * different description of the same documents would give this application two answers to "what is a
 * valid manifest", and the day they disagree the editor confidently suggests a field the loader
 * rejects.
 *
 * So this describes only what an editor needs and a validator cannot give: the *names*, in the order
 * a human wants to see them, with a sentence each. Everything a schema language spends its complexity
 * on — `oneOf`, `$ref`, conditional subschemas — buys nothing at a caret and would have to be
 * interpreted correctly to avoid suggesting nonsense.
 *
 * ## Extensibility
 *
 * A shape is data. A new file kind is a new description and an entry in whatever registry maps paths
 * to them; nothing in the completion engine learns about it. Descriptions of the shipped manifests are
 * written as `Record<keyof T, …>` over the manifest's own type, so adding a field to the type fails to
 * compile until the field is described — which is the only way a feature like this stays true a year
 * from now rather than quietly drifting into a list of names that used to be right.
 */

export type SchemaShape =
  | { readonly kind: 'string'; readonly values?: readonly string[] }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'object'; readonly fields: readonly SchemaField[] }
  | { readonly kind: 'array'; readonly of: SchemaShape }
  /** Something this description does not model — free-form parameters, a nested graph. */
  | { readonly kind: 'unknown' };

export interface SchemaField {
  readonly name: string;
  readonly shape: SchemaShape;
  /** Shown beside the name. One line: what it is for, not how it works. */
  readonly doc?: string;
  /** Marked in the list, so a half-written manifest shows what it still owes. */
  readonly required?: boolean;
}

/** Convenience for the common case, so a description reads as a list of names rather than as types. */
export function object(fields: readonly SchemaField[]): SchemaShape {
  return { kind: 'object', fields };
}

export function arrayOf(of: SchemaShape): SchemaShape {
  return { kind: 'array', of };
}

/** A string constrained to a fixed set, which is what makes value completion worth having. */
export function oneOf(values: readonly string[]): SchemaShape {
  return { kind: 'string', values };
}

/**
 * The shape at a path, or `undefined` where the description says nothing.
 *
 * `undefined` rather than a permissive fallback: a caret somewhere unmodelled should offer *nothing*,
 * because a list of plausible-looking names that do not belong there is worse than an empty popup. The
 * user can tell an absent feature from a wrong one.
 */
export function shapeAt(root: SchemaShape, path: readonly JsonPathStep[]): SchemaShape | undefined {
  let shape: SchemaShape | undefined = root;

  for (const step of path) {
    if (shape === undefined) return undefined;

    if (typeof step === 'number') {
      // An index only means anything in an array. Meeting one anywhere else means the file's shape
      // and the description have parted company, and guessing from there compounds it.
      shape = shape.kind === 'array' ? shape.of : undefined;
      continue;
    }

    shape = shape.kind === 'object' ? shape.fields.find((field) => field.name === step)?.shape : undefined;
  }

  return shape;
}
