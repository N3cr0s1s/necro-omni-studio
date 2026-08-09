import { type SchemaField, type SchemaShape, arrayOf, object, oneOf } from '@nos/core';
import { PARAM_TYPES } from '../contracts/manifest.js';
import type { ConsumesDescriptor, GeneratorPreset, OutputDescriptor } from '../contracts/manifest.js';
import type { GeneratorManifestFile, GeneratorParamFile } from './manifest-file.js';

/**
 * What a generator manifest may contain, for the editor to complete against — issue #31.
 *
 * ## Why this is written as a record over the type
 *
 * Every description below is a `Record<keyof T, SchemaField>`, so adding a field stops the build until
 * the field is described. Without that this file is a list of names that was accurate on the day it was
 * written and drifts silently afterwards — and a completion list that is *almost* right is worse than
 * none, because it is trusted. The compiler is the only thing that keeps a mirror like this honest.
 *
 * The types keyed on are the **file's**, not the in-memory model's. The on-disk format is snake_case
 * per the spec — `default_variants`, `duration_from`, `default_from` — and `parseManifestFile`
 * translates. Describing the camelCase names would offer fields the loader drops without a word, which
 * is the first thing the check against the shipped manifests caught.
 *
 * The one thing it cannot check is the prose, and the prose is most of the value: a name a user could
 * have guessed does not need completing.
 */

/** Assets a generator can take or make. Mirrors `AssetType`, which is a union of string literals. */
const ASSET_TYPES = ['image', 'video', 'audio', 'text', 'mask'] as const;

const CONSUMES: Record<keyof ConsumesDescriptor, SchemaField> = {
  type: { name: 'type', shape: oneOf(ASSET_TYPES), required: true, doc: 'What kind of asset it takes.' },
  role: {
    name: 'role',
    shape: { kind: 'string' },
    doc: 'What the input means — first_frame, script, voice_reference. What makes it placeable.',
  },
  required: { name: 'required', shape: { kind: 'boolean' }, doc: 'Whether a run can start without it.' },
  sources: {
    name: 'sources',
    shape: arrayOf(oneOf(['inline', 'notes_file', 'text_clip'])),
    doc: 'Where a text input may come from.',
  },
};

const PARAM: Record<keyof GeneratorParamFile, SchemaField> = {
  key: {
    name: 'key',
    shape: { kind: 'string' },
    required: true,
    doc: 'Identifier, unique in this manifest.',
  },
  label: { name: 'label', shape: { kind: 'string' }, doc: 'Shown on the control. Falls back to the key.' },
  type: { name: 'type', shape: oneOf(PARAM_TYPES), required: true, doc: 'Which control is drawn.' },
  bind: {
    name: 'bind',
    shape: { kind: 'unknown' },
    required: true,
    doc: 'Where the value is patched into the graph. null for a manifest with no graph yet.',
  },
  also: {
    name: 'also',
    shape: arrayOf({ kind: 'unknown' }),
    doc: 'Further places the value must be written, optionally through a template.',
  },
  multiline: { name: 'multiline', shape: { kind: 'boolean' }, doc: 'Draw a text area rather than a field.' },
  min: { name: 'min', shape: { kind: 'number' }, doc: 'Lowest accepted value.' },
  max: { name: 'max', shape: { kind: 'number' }, doc: 'Highest accepted value.' },
  step: { name: 'step', shape: { kind: 'number' }, doc: 'Increment the control moves by.' },
  default: { name: 'default', shape: { kind: 'unknown' }, doc: 'Value the control starts at.' },
  default_from: {
    name: 'default_from',
    shape: { kind: 'string' },
    doc: 'A default the application derives from the project, such as the sequence aspect.',
  },
  options: {
    name: 'options',
    shape: { kind: 'unknown' },
    doc: 'A fixed list, or { "from": "capabilities" } to read one live from the backend.',
  },
  required: { name: 'required', shape: { kind: 'boolean' }, doc: 'Whether a run can start without it.' },
  transport: {
    name: 'transport',
    shape: { kind: 'string' },
    doc: 'How an asset parameter reaches the backend, e.g. upload_image.',
  },
};

const OUTPUT: Record<keyof OutputDescriptor, SchemaField> = {
  key: { name: 'key', shape: { kind: 'string' }, required: true, doc: 'Identifier for the output.' },
  type: { name: 'type', shape: oneOf(ASSET_TYPES), required: true, doc: 'What kind of asset it produces.' },
  node: {
    name: 'node',
    shape: { kind: 'unknown' },
    required: true,
    doc: 'Graph node the output comes from. null for a manifest with no graph yet.',
  },
  optional: { name: 'optional', shape: { kind: 'boolean' }, doc: 'Whether a run may finish without it.' },
  format: { name: 'format', shape: { kind: 'string' }, doc: 'e.g. word_timings for a speech alignment.' },
};

const PRESET: Record<keyof GeneratorPreset, SchemaField> = {
  id: { name: 'id', shape: { kind: 'string' }, required: true, doc: 'Identifier, unique in this manifest.' },
  name: { name: 'name', shape: { kind: 'string' }, required: true, doc: 'Shown in the picker.' },
  pin: {
    name: 'pin',
    shape: { kind: 'unknown' },
    required: true,
    doc: 'Values that constitute the preset: fixed and hidden.',
  },
  set: {
    name: 'set',
    shape: { kind: 'unknown' },
    doc: 'Values the preset starts from, still editable.',
  },
};

const MANIFEST: Record<keyof GeneratorManifestFile, SchemaField> = {
  id: { name: 'id', shape: { kind: 'string' }, required: true, doc: 'Identifier, and the file name.' },
  name: { name: 'name', shape: { kind: 'string' }, required: true, doc: 'Shown wherever it is offered.' },
  backend: { name: 'backend', shape: { kind: 'string' }, required: true, doc: 'Which backend runs it.' },
  graph: {
    name: 'graph',
    shape: { kind: 'unknown' },
    required: true,
    doc: 'Graph file name, or null for a contract written before its graph exists.',
  },
  status: {
    name: 'status',
    shape: oneOf(['available', 'unavailable', 'unbound']),
    doc: 'Declared by a manifest that knows it is not yet runnable.',
  },
  produces: { name: 'produces', shape: oneOf(ASSET_TYPES), required: true, doc: 'What it makes.' },
  consumes: {
    name: 'consumes',
    shape: arrayOf(object(fields(CONSUMES))),
    required: true,
    doc: 'What it takes.',
  },
  surfaces: {
    name: 'surfaces',
    shape: arrayOf({ kind: 'string' }),
    required: true,
    doc: 'Where its action appears in the application.',
  },
  duration: {
    name: 'duration',
    shape: oneOf(['declared', 'discovered']),
    required: true,
    doc: 'declared: a parameter fixes the length. discovered: only the output reveals it.',
  },
  duration_from: {
    name: 'duration_from',
    shape: object([
      { name: 'param', shape: { kind: 'string' }, required: true, doc: 'Which parameter carries it.' },
      { name: 'unit', shape: oneOf(['seconds', 'frames']), required: true, doc: 'What it is measured in.' },
    ]),
    doc: 'Which parameter carries the declared length, for sizing a placeholder before the job runs.',
  },
  default_variants: {
    name: 'default_variants',
    shape: { kind: 'number' },
    required: true,
    doc: 'How many takes a run asks for by default.',
  },
  batch: {
    name: 'batch',
    shape: object([
      { name: 'bind', shape: { kind: 'unknown' }, required: true, doc: 'Where the count is patched in.' },
      { name: 'max', shape: { kind: 'number' }, required: true, doc: 'Most variants one submit can make.' },
    ]),
    doc: 'Present only when the graph can produce several variants in one submit.',
  },
  requires: {
    name: 'requires',
    shape: arrayOf({ kind: 'string' }),
    required: true,
    doc: 'Node classes the backend must have installed. Checked against its capabilities.',
  },
  outputs: {
    name: 'outputs',
    shape: arrayOf(object(fields(OUTPUT))),
    required: true,
    doc: 'What a run returns.',
  },
  params: {
    name: 'params',
    shape: arrayOf(object(fields(PARAM))),
    required: true,
    doc: 'The controls it shows.',
  },
  presets: {
    name: 'presets',
    shape: arrayOf(object(fields(PRESET))),
    required: true,
    doc: 'Named starting points, each its own entry in the picker.',
  },
  exclusive: {
    name: 'exclusive',
    shape: arrayOf(
      object([
        { name: 'members', shape: arrayOf({ kind: 'string' }), required: true, doc: 'Parameter keys.' },
        { name: 'label', shape: { kind: 'string' }, doc: 'Shown above the choice.' },
        { name: 'required', shape: { kind: 'boolean' }, doc: 'Whether one of them must be given.' },
      ]),
    ),
    doc: 'Parameters that are alternatives to one another.',
  },
};

/**
 * The record's values, in declaration order.
 *
 * The order is the point: a manifest has a shape its author had in mind — identity, then what it takes
 * and makes, then how it runs — and an alphabetical list throws away the only ordering anyone chose.
 */
function fields(record: Record<string, SchemaField>): readonly SchemaField[] {
  return Object.values(record);
}

export const GENERATOR_MANIFEST_SCHEMA: SchemaShape = object(fields(MANIFEST));
