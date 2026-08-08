import { type Result, err, ok } from '../lang/result.js';
import { type ValidationIssue, formatIssues, validate } from '../lang/validate.js';
import { type TimelineDocument } from '../document/document.js';
import { vTimelineDocument } from './document-schema.js';
import { type MigrationError, describeMigrationError, migrateDocument } from './migrate.js';
import { type JsonObject, stringifyDocument } from './serialize.js';

/**
 * `project.json` load and save.
 *
 * Pure: text in, document out. No filesystem access, so the whole pipeline —
 * parse, migrate, validate — is unit-testable against string fixtures, and the same code
 * serves the desktop app, a CLI and the crash-recovery reader.
 */

export const PROJECT_FILE_NAME = 'project.json';

export type LoadError =
  | { readonly kind: 'invalid-json'; readonly message: string }
  | { readonly kind: 'not-an-object' }
  | { readonly kind: 'migration'; readonly error: MigrationError }
  | { readonly kind: 'invalid-document'; readonly issues: readonly ValidationIssue[] };

export interface LoadOutcome {
  readonly document: TimelineDocument;
  /** Migration steps applied, so the UI can say the project was upgraded. */
  readonly migrationsApplied: readonly string[];
}

/**
 * Parses, migrates and validates `project.json` text.
 *
 * The order matters: migration runs on raw JSON before validation, because an old file by
 * definition does not satisfy the current schema. Validation then runs once, against the
 * current shape, and reports every problem at once.
 */
export function loadDocument(text: string): Result<LoadOutcome, LoadError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return err({
      kind: 'invalid-json',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err({ kind: 'not-an-object' });
  }

  const migrated = migrateDocument(parsed as JsonObject);
  if (!migrated.ok) return err({ kind: 'migration', error: migrated.error });

  const validated = validate(vTimelineDocument, migrated.value.document);
  if (!validated.ok) return err({ kind: 'invalid-document', issues: validated.error });

  return ok({
    document: validated.value,
    migrationsApplied: migrated.value.applied,
  });
}

/** Renders `project.json` text for a document. */
export function saveDocument(document: TimelineDocument): string {
  return stringifyDocument(document);
}

/**
 * A message suitable for a dialog.
 *
 * Load failures are shown to the user, so they name the offending path rather than
 * reporting "invalid project" — the same reasoning as the spec's requirement that a broken
 * manifest names its broken pointer.
 */
export function describeLoadError(error: LoadError): string {
  switch (error.kind) {
    case 'invalid-json':
      return `project.json is not valid JSON: ${error.message}`;
    case 'not-an-object':
      return 'project.json must contain a JSON object at its root';
    case 'migration':
      return describeMigrationError(error.error);
    case 'invalid-document':
      return `project.json does not match the expected shape:\n${formatIssues(error.issues)}`;
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled load error ${JSON.stringify(unreachable)}`);
    }
  }
}
