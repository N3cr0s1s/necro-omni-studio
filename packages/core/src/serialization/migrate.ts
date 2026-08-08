import { type Result, err, ok } from '../lang/result.js';
import { type JsonObject } from './serialize.js';
import { SCHEMA_VERSION } from '../document/document.js';

/**
 * `project.json` migration chain.
 *
 * ## Why a chain rather than one big reader
 *
 * A project folder is the durable artifact — a user can open one authored a year and
 * twenty releases ago. Writing "if version <= 3 then also do X" branches into the parser
 * makes it progressively unreadable and untestable. Instead each release contributes one
 * small step that upgrades version N to N+1 on the raw JSON, and loading runs the steps in
 * order before validation. Every step then only has to know about two adjacent shapes.
 *
 * Migrations operate on plain JSON, *before* validation, because a v1 file by definition
 * does not satisfy the current validator. Validation happens once, at the end, against the
 * current schema.
 */
export interface Migration {
  /** Version this step reads. It produces `from + 1`. */
  readonly from: number;
  readonly description: string;
  readonly migrate: (input: JsonObject) => JsonObject;
}

export type MigrationError =
  | {
      readonly kind: 'from-the-future';
      readonly fileVersion: number;
      readonly supportedVersion: number;
    }
  | { readonly kind: 'missing-version' }
  | { readonly kind: 'no-migration-path'; readonly fileVersion: number }
  | { readonly kind: 'migration-failed'; readonly from: number; readonly message: string };

/**
 * The registered migrations, ordered.
 *
 * Empty at v1: there is no earlier shape to upgrade from. When the schema changes, bump
 * `SCHEMA_VERSION`, append a step here, and add a fixture test that loads a file of the
 * old shape. Do not edit an existing step — a released migration is part of the contract
 * with every project folder already on disk.
 */
export const MIGRATIONS: readonly Migration[] = [];

export interface MigrationOutcome {
  readonly document: JsonObject;
  /** Steps that ran, for a "this project was upgraded from v1" notice. */
  readonly applied: readonly string[];
}

/**
 * Brings a raw parsed `project.json` up to the current schema version.
 *
 * A file from a *newer* build is refused rather than best-effort parsed: silently dropping
 * fields the running build does not understand and then saving would destroy the user's
 * work in a way they could not see coming.
 */
export function migrateDocument(
  input: JsonObject,
  targetVersion: number = SCHEMA_VERSION,
): Result<MigrationOutcome, MigrationError> {
  const rawVersion = input['schemaVersion'];
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    return err({ kind: 'missing-version' });
  }

  if (rawVersion > targetVersion) {
    return err({
      kind: 'from-the-future',
      fileVersion: rawVersion,
      supportedVersion: targetVersion,
    });
  }

  let current = input;
  let version = rawVersion;
  const applied: string[] = [];

  while (version < targetVersion) {
    const step = MIGRATIONS.find((migration) => migration.from === version);
    if (step === undefined) {
      return err({ kind: 'no-migration-path', fileVersion: version });
    }
    try {
      current = { ...step.migrate(current), schemaVersion: version + 1 };
    } catch (error) {
      return err({
        kind: 'migration-failed',
        from: version,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    applied.push(step.description);
    version += 1;
  }

  return ok({ document: current, applied });
}

export function describeMigrationError(error: MigrationError): string {
  switch (error.kind) {
    case 'missing-version':
      return 'project.json has no schemaVersion field, so it cannot be identified as a project file';
    case 'from-the-future':
      return `This project was saved by a newer version of the application (schema v${error.fileVersion}, this build supports v${error.supportedVersion}). Opening it here would discard data it contains.`;
    case 'no-migration-path':
      return `No migration is registered for schema v${error.fileVersion}`;
    case 'migration-failed':
      return `Migration from schema v${error.from} failed: ${error.message}`;
    default: {
      const unreachable: never = error;
      throw new Error(`Unhandled migration error ${JSON.stringify(unreachable)}`);
    }
  }
}
