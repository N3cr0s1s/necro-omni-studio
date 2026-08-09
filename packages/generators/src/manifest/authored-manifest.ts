import { generatorId, presetId } from '@nos/core';
import type { GeneratorManifest } from '../contracts/manifest.js';

/**
 * A manifest that uses every field the contract declares.
 *
 * Two checks read it and they need different things from it. `manifest-draft.test.ts` opens it in the
 * inspector's draft and writes it back, asserting nothing changed — which is blind to a field the
 * fixture never sets. `every-field.test.ts` reads the contract's own source and asserts that nothing
 * it declares is missing from what came back — which cannot tell whether what survived is intact.
 *
 * The pairing matters here more than anywhere else in this repository: the round trip through the
 * manifest inspector has silently deleted fields from real, shipped manifests **three times** — the
 * `also` bindings a length expression depends on, `defaultFrom` and `durationFrom`, then `exclusive`,
 * and then the capability-driven `options` that three of the five shipped manifests use for their
 * sampler, scheduler, LoRA and aspect-ratio dropdowns. Each time the fix was one field and each time
 * the next one was already waiting, because the fixture was what decided which fields were checked.
 */
export const AUTHORED_MANIFEST: GeneratorManifest = {
  id: generatorId('minimax_h3_i2v'),
  name: 'MiniMax H3 i2v',
  backend: 'comfyui',
  graph: 'video_minimax_h3_i2v.json',
  produces: 'video',
  consumes: [{ type: 'image', role: 'first_frame', required: true, sources: ['media', 'generated'] }],
  surfaces: ['frame_context_menu'],
  duration: 'declared',
  durationFrom: { param: 'duration_s', unit: 'seconds' },
  defaultVariants: 1,
  requires: ['MiniMaxNode'],
  batch: { bind: '/105:15/inputs/batch_size', max: 4 },
  outputs: [{ key: 'video', type: 'video', node: '92', optional: true, format: 'mp4' }],
  params: [
    {
      key: 'first_frame',
      type: 'image',
      required: true,
      bind: '/114/inputs/image',
      transport: 'upload_image',
    },
    {
      key: 'duration_s',
      label: 'Length',
      type: 'float',
      min: 0.5,
      max: 30,
      step: 0.5,
      default: 15,
      bind: '/105:111/inputs/value',
    },
    { key: 'prompt', type: 'text', multiline: true, default: '', bind: '/105:12/inputs/text' },
    {
      key: 'sampler',
      type: 'enum',
      options: ['euler', 'dpmpp_2m'],
      default: 'euler',
      bind: '/105:15/inputs/sampler_name',
    },
    {
      /*
       * A dropdown the backend fills in. Three of the five shipped manifests do this, and the draft
       * could not hold the shape at all — `options` was typed as a list, so reopening one of them
       * turned its sampler, scheduler and LoRA choices into free text. `every-field.test.ts` is what
       * noticed the fixture had never carried one.
       */
      key: 'model',
      type: 'enum',
      options: { from: 'capabilities', nodeClass: 'CheckpointLoaderSimple', input: 'ckpt_name' },
      bind: '/105:4/inputs/ckpt_name',
    },
    {
      key: 'fps',
      type: 'int',
      default: 25,
      bind: '/105:110/inputs/value',
      // The spec's own `also` example, copied from the project's real MiniMax manifests: `fps` is
      // both a literal and part of a length expression, and a round trip that kept only the first
      // left the expression stale and delivered a clip of the wrong duration.
      also: [
        {
          pointer: '/105:107/inputs/expression',
          template: 'max(5, round(a * {fps}))',
        },
      ],
    },
    {
      key: 'width',
      type: 'int',
      default: 1280,
      bind: '/105:20/inputs/width',
      defaultFrom: 'project_width',
    },
    { key: 'seed', type: 'seed', bind: '/105:15/inputs/noise_seed' },
  ],
  presets: [{ id: presetId('fast'), name: 'Fast', pin: { fps: 16 }, set: { duration_s: 5 } }],
  exclusive: [{ members: ['fps', 'width'], label: 'Timing', required: true }],
};
