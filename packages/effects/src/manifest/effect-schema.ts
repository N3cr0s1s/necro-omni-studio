import { type SchemaField, type SchemaShape, arrayOf, object, oneOf } from '@nos/core';
import { PARAM_TYPES } from './effect-manifest.js';
import type { EffectParam, TransitionManifest } from './effect-manifest.js';

/**
 * What an effect or transition manifest may contain, for the editor to complete against — issue #31.
 *
 * ## Why the names here are the file's, not the type's
 *
 * The on-disk format is snake_case per `interfaces.md` and the in-memory model is camelCase, with
 * `normalizeManifestKeys` translating between them. Completion happens in a *text editor*, so the
 * names offered must be the ones the file uses: suggesting `progressUniform` would produce a manifest
 * that loads with the field silently missing, because the translator only knows `progress_uniform`.
 *
 * That is exactly why the mapping below is written as a `Record<keyof TransitionManifest, …>` whose
 * *values* carry the on-disk spelling. The record keeps the compiler checking that every field of the
 * type is accounted for; the `name` inside each entry is what the user actually types. A plain list
 * would have neither guarantee.
 */

const PARAM: Record<keyof EffectParam, SchemaField> = {
  key: {
    name: 'key',
    shape: { kind: 'string' },
    required: true,
    doc: 'Document-side key. What a clip’s stored parameters are keyed by.',
  },
  uniform: {
    name: 'uniform',
    shape: { kind: 'string' },
    required: true,
    doc: 'Shader-side uniform name. Often differs from the key; both spellings are yours to choose.',
  },
  type: { name: 'type', shape: oneOf(PARAM_TYPES), required: true, doc: 'Which GLSL type it becomes.' },
  label: { name: 'label', shape: { kind: 'string' }, doc: 'Shown in the inspector. Falls back to the key.' },
  min: { name: 'min', shape: { kind: 'number' }, doc: 'Lowest accepted value.' },
  max: { name: 'max', shape: { kind: 'number' }, doc: 'Highest accepted value.' },
  step: { name: 'step', shape: { kind: 'number' }, doc: 'Increment the control moves by.' },
  default: {
    name: 'default',
    shape: { kind: 'unknown' },
    doc: 'Applied when a clip adds this effect. A number, a boolean, or components for a colour.',
  },
  keyframable: {
    name: 'keyframable',
    shape: { kind: 'boolean' },
    doc: 'Whether it can be animated. Defaults to true for numeric types and is forced false for the rest.',
  },
};

/**
 * Both categories in one description.
 *
 * A manifest declares which it is, and the fields that belong only to a transition — `convention`,
 * `progress_uniform` — are marked as such in their prose rather than hidden. Offering the union is the
 * honest behaviour while the file is half-written: the `category` line is frequently the *last* thing
 * typed, and a completion list that stays empty until it exists would be useless exactly when a new
 * manifest is being started.
 */
const MANIFEST: Record<keyof TransitionManifest, SchemaField> = {
  id: { name: 'id', shape: { kind: 'string' }, required: true, doc: 'Identifier, and the file name.' },
  name: { name: 'name', shape: { kind: 'string' }, required: true, doc: 'Shown in the add-effect menu.' },
  category: {
    name: 'category',
    shape: oneOf(['effect', 'transition']),
    required: true,
    doc: 'An effect changes one clip; a transition blends two.',
  },
  shader: {
    name: 'shader',
    shape: { kind: 'string' },
    required: true,
    doc: 'Shader file name, relative to this manifest.',
  },
  params: {
    name: 'params',
    shape: arrayOf(object(Object.values(PARAM))),
    required: true,
    doc: 'Its controls.',
  },
  samplers: {
    name: 'samplers',
    shape: arrayOf(oneOf(['source', 'mask'])),
    required: true,
    doc: 'Texture slots. Naming "mask" is the whole of how an effect opts into segmentation.',
  },
  group: {
    name: 'group',
    shape: { kind: 'string' },
    doc: 'Grouping for the add-effect menu. Free-form, so a project can organize its own library.',
  },
  description: { name: 'description', shape: { kind: 'string' }, doc: 'One line about what it does.' },
  convention: {
    name: 'convention',
    shape: oneOf(['gl-transitions']),
    doc: 'Transitions only. Generates the gl-transitions wrapper so an unmodified shader compiles.',
  },
  progressUniform: {
    // The file's spelling, not the type's. Suggesting the camelCase name would write a field the
    // loader's translator does not know, and it would go missing without a word.
    name: 'progress_uniform',
    shape: { kind: 'string' },
    doc: 'Transitions only. Uniform carrying engine-computed progress. Defaults to "progress".',
  },
};

export const EFFECT_MANIFEST_SCHEMA: SchemaShape = object(Object.values(MANIFEST));
