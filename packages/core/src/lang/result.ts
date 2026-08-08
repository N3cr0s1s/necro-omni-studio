/**
 * Explicit success/failure values.
 *
 * Used for every operation whose failure is an expected outcome rather than a
 * defect: manifest validation, pointer resolution, shader compilation, document
 * migration. Thrown exceptions stay reserved for programmer error, which keeps the
 * "unavailable generator with a concrete reason" requirement expressible in the
 * type system instead of in prose.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Unwraps a result, throwing on failure. For call sites where failure genuinely is
 * a defect (already-validated data, test assertions) — never for user input.
 */
export function expect<T, E>(result: Result<T, E>, message: string): T {
  if (result.ok) return result.value;
  throw new Error(`${message}: ${describeError(result.error)}`);
}

/**
 * Collects a list of results into a result of a list, accumulating every error
 * rather than stopping at the first. Manifest validation reports all broken
 * pointers at once, because fixing them one round-trip at a time is what makes
 * "where is my tool" debugging expensive.
 */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return errors.length > 0 ? err(errors) : ok(values);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}
