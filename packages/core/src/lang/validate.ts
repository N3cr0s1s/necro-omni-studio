import { type Result, err, ok } from './result.js';

/**
 * A tiny structural validation library.
 *
 * Three things in this codebase parse untrusted JSON: `project.json`, generator
 * manifests and effect manifests. All three have the same requirement — report *every*
 * problem at once, each with the JSON path that caused it — because the spec is explicit
 * that a broken manifest must name its broken pointer rather than failing opaquely.
 * Hunting one error per reload is exactly the "where is my tool" cost the spec calls out.
 *
 * Hand-rolled rather than a schema library dependency: the error shape is the product
 * requirement here, `@nos/core` stays dependency-free so it can run in a worker, and the
 * combinators below are about a hundred lines.
 */
export interface ValidationIssue {
  /** JSON path, e.g. `sequence.tracks[2].clips[0].span.start`. */
  readonly path: string;
  readonly message: string;
}

export type Validated<T> = Result<T, readonly ValidationIssue[]>;

/** Parses an unknown value at a path, collecting all issues rather than stopping early. */
export type Validator<T> = (value: unknown, path: string) => Validated<T>;

export function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function fail<T>(path: string, message: string): Validated<T> {
  return err([issue(path, message)]);
}

/** Joins a parent path with a key, producing `a.b` and `a.b[0]` forms. */
export function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path.length === 0 ? key : `${path}.${key}`;
}

/** Human-readable type name for error messages; distinguishes null and arrays. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export const vString: Validator<string> = (value, path) =>
  typeof value === 'string' ? ok(value) : fail(path, `expected string, got ${typeName(value)}`);

export const vNumber: Validator<number> = (value, path) => {
  if (typeof value !== 'number') return fail(path, `expected number, got ${typeName(value)}`);
  // NaN and Infinity survive JSON round-trips as `null`, but arrive from hand-edited
  // files and from arithmetic upstream. They poison every downstream calculation
  // silently, so they are rejected at the boundary.
  if (!Number.isFinite(value)) return fail(path, `expected a finite number, got ${value}`);
  return ok(value);
};

export const vInteger: Validator<number> = (value, path) => {
  const asNumber = vNumber(value, path);
  if (!asNumber.ok) return asNumber;
  return Number.isInteger(asNumber.value)
    ? ok(asNumber.value)
    : fail(path, `expected an integer, got ${asNumber.value}`);
};

export const vBoolean: Validator<boolean> = (value, path) =>
  typeof value === 'boolean' ? ok(value) : fail(path, `expected boolean, got ${typeName(value)}`);

export function vLiteral<const T extends string | number | boolean>(literal: T): Validator<T> {
  return (value, path) =>
    value === literal
      ? ok(literal)
      : fail(path, `expected ${JSON.stringify(literal)}, got ${JSON.stringify(value)}`);
}

/** Accepts one of a fixed set of strings, listing the alternatives on failure. */
export function vEnum<const T extends string>(options: readonly T[]): Validator<T> {
  return (value, path) => {
    if (typeof value !== 'string') {
      return fail(path, `expected one of ${options.join(' | ')}, got ${typeName(value)}`);
    }
    return (options as readonly string[]).includes(value)
      ? ok(value as T)
      : fail(path, `expected one of ${options.join(' | ')}, got ${JSON.stringify(value)}`);
  };
}

/**
 * Validates every element, accumulating issues across all of them.
 *
 * A file with ten malformed clips should report ten problems, not the first one.
 */
export function vArray<T>(element: Validator<T>): Validator<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, `expected array, got ${typeName(value)}`);
    const values: T[] = [];
    const issues: ValidationIssue[] = [];
    value.forEach((item, index) => {
      const result = element(item, childPath(path, index));
      if (result.ok) values.push(result.value);
      else issues.push(...result.error);
    });
    return issues.length > 0 ? err(issues) : ok(values);
  };
}

/** Field validators for an object shape. */
export type ObjectShape<T> = { readonly [K in keyof T]-?: Validator<T[K]> };

/**
 * Validates an object against a shape, accumulating issues from every field.
 *
 * Unknown keys are ignored rather than rejected: a project saved by a newer build must
 * still open in an older one with the fields it understands, which matters for a tool
 * whose implementation is expected to churn.
 */
export function vObject<T extends object>(shape: ObjectShape<T>): Validator<T> {
  return (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, `expected object, got ${typeName(value)}`);
    }
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const issues: ValidationIssue[] = [];

    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      const validator = shape[key];
      const result = validator(source[key], childPath(path, key));
      if (result.ok) {
        // Drop undefined so the result satisfies `exactOptionalPropertyTypes`: an absent
        // optional field must be missing, not present-and-undefined.
        if (result.value !== undefined) output[key] = result.value;
      } else {
        issues.push(...result.error);
      }
    }

    return issues.length > 0 ? err(issues) : ok(output as T);
  };
}

/** Makes a field optional; `null` is treated as absent, since JSON writers emit both. */
export function vOptional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value, path) => {
    if (value === undefined || value === null) return ok(undefined);
    return inner(value, path);
  };
}

/** Supplies a default when a field is absent. A *present but invalid* value still fails. */
export function vWithDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
  return (value, path) => {
    if (value === undefined || value === null) return ok(fallback);
    return inner(value, path);
  };
}

/**
 * Supplies a default when a field is absent **or invalid**.
 *
 * Reserved for closed vocabularies where an unknown member should degrade rather than
 * reject the whole file — an easing keyword from a build that has Bezier support, say. The
 * timeline showing that one segment straight is a far better outcome than refusing to open
 * the project.
 *
 * Deliberately *not* the default behaviour: swallowing validation failures generally would
 * turn a typo into silent data loss on the next save. Every use of this needs that
 * trade-off to be true for the specific field.
 */
export function vFallback<T>(inner: Validator<T>, fallback: T): Validator<T> {
  return (value, path) => {
    if (value === undefined || value === null) return ok(fallback);
    const result = inner(value, path);
    return result.ok ? result : ok(fallback);
  };
}

/**
 * Dispatches on a discriminant field.
 *
 * Reports "unknown kind" against the discriminant rather than dumping every variant's
 * failures, which is what makes a typo in `kind` readable instead of a wall of noise.
 */
export function vTagged<T extends object>(
  discriminant: string,
  variants: Readonly<Record<string, Validator<T>>>,
): Validator<T> {
  return (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, `expected object, got ${typeName(value)}`);
    }
    const tag = (value as Record<string, unknown>)[discriminant];
    if (typeof tag !== 'string') {
      return fail(
        childPath(path, discriminant),
        `expected one of ${Object.keys(variants).join(' | ')}, got ${typeName(tag)}`,
      );
    }
    const variant = variants[tag];
    if (variant === undefined) {
      return fail(
        childPath(path, discriminant),
        `unknown ${discriminant} ${JSON.stringify(tag)}, expected one of ${Object.keys(variants).join(' | ')}`,
      );
    }
    return variant(value, path);
  };
}

/** Validates a string-keyed map of uniform values. */
export function vRecord<T>(element: Validator<T>): Validator<Readonly<Record<string, T>>> {
  return (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, `expected object, got ${typeName(value)}`);
    }
    const output: Record<string, T> = {};
    const issues: ValidationIssue[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = element(item, childPath(path, key));
      if (result.ok) output[key] = result.value;
      else issues.push(...result.error);
    }
    return issues.length > 0 ? err(issues) : ok(output);
  };
}

/**
 * Applies a total transformation after validation, e.g. widening a string to a branded id.
 *
 * `transform` must not throw. Use `vTryMap` when the conversion can legitimately fail.
 */
export function vMap<A, B>(inner: Validator<A>, transform: (value: A) => B): Validator<B> {
  return (value, path) => {
    const result = inner(value, path);
    return result.ok ? ok(transform(result.value)) : result;
  };
}

/**
 * Applies a partial transformation, turning a thrown error into a validation issue.
 *
 * This is the bridge to the validating factories (`assetPath`, `frameIndex`,
 * `parseFrameRate`), which throw by design: their invariants are programmer-level
 * everywhere except at this boundary, where the input is untrusted.
 */
export function vTryMap<A, B>(inner: Validator<A>, transform: (value: A) => B): Validator<B> {
  return (value, path) => {
    const result = inner(value, path);
    if (!result.ok) return result;
    try {
      return ok(transform(result.value));
    } catch (error) {
      return fail(path, error instanceof Error ? error.message : String(error));
    }
  };
}

/** Adds a predicate check after validation. */
export function vRefine<T>(
  inner: Validator<T>,
  predicate: (value: T) => boolean,
  message: string,
): Validator<T> {
  return (value, path) => {
    const result = inner(value, path);
    if (!result.ok) return result;
    return predicate(result.value) ? result : fail(path, message);
  };
}

export function vNonEmptyString(label = 'value'): Validator<string> {
  return vRefine(vString, (value) => value.trim().length > 0, `${label} must not be empty`);
}

export function vFiniteInRange(min: number, max: number): Validator<number> {
  return vRefine(vNumber, (value) => value >= min && value <= max, `expected a value in [${min}, ${max}]`);
}

export function vPositiveInteger(label = 'value'): Validator<number> {
  return vRefine(vInteger, (value) => value > 0, `${label} must be positive`);
}

export function vNonNegativeInteger(label = 'value'): Validator<number> {
  return vRefine(vInteger, (value) => value >= 0, `${label} must not be negative`);
}

/** Formats issues for a log line or an error dialog. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((entry) => `${entry.path || '<root>'}: ${entry.message}`).join('\n');
}

/** Runs a validator from the document root. */
export function validate<T>(validator: Validator<T>, value: unknown): Validated<T> {
  return validator(value, '');
}
