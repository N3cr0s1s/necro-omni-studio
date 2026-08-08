import type { AssetType } from '@nos/core';
import type { ConsumesDescriptor, GeneratorParamType } from '../contracts/manifest.js';
import type { DraftParam } from './manifest-draft.js';
import { TEXT_SOURCES, type TextSource } from '../panel/text-inputs.js';

/**
 * What a generator being authored consumes.
 *
 * §5.2 makes this the load-bearing declaration of the whole framework: a manifest does not say "this is
 * a video generator", it says what it *takes* and what it *produces*, and the UI derives from that
 * where the action appears. §5.9 then promises the inspector writes manifests without anyone touching
 * code — but `consumes` had no control at all, so every manifest authored there declared it consumed
 * nothing, and the one field the surfaces are derived from could only be filled in by hand-editing the
 * JSON the inspector exists to avoid writing.
 *
 * ## Suggested, then confirmed
 *
 * The inputs are *derived from the parameters* rather than asked for a second time: a parameter of type
 * `image` is a generator taking an image, and making the user say so twice invites the two to disagree.
 * The suggestion is a starting point the user edits — roles carry meaning no derivation can invent
 * (`first_frame` and `style_reference` are both images), which is exactly why the manifest requires one.
 */

/** Parameter types that mean "this generator takes one of these". */
const CONSUMED_TYPES: ReadonlyMap<GeneratorParamType, AssetType> = new Map([
  ['image', 'image'],
  ['video', 'video'],
  ['audio', 'audio'],
  ['mask', 'mask'],
  ['text', 'text'],
]);

export function consumedTypeOf(type: GeneratorParamType): AssetType | undefined {
  return CONSUMED_TYPES.get(type);
}

/**
 * The inputs a draft's parameters imply, in declaration order.
 *
 * The role defaults to the parameter's key, which is what `inputFor` matches on — so a suggestion that
 * is accepted unchanged is already correctly wired to its parameter rather than merely plausible.
 *
 * Text inputs are suggested with every source this build understands. A text-to-speech script that
 * could be typed, taken from `notes/` or taken from a clip is the case §10 describes, and offering the
 * narrow default here would mean the inspector could only author the least capable version.
 */
export function suggestedConsumes(params: readonly DraftParam[]): readonly ConsumesDescriptor[] {
  const suggestions: ConsumesDescriptor[] = [];

  for (const param of params) {
    const type = consumedTypeOf(param.type);
    if (type === undefined) continue;

    suggestions.push({
      type,
      role: param.key,
      required: param.required === true,
      ...(type === 'text' ? { sources: [...TEXT_SOURCES] } : {}),
    });
  }

  return suggestions;
}

/**
 * The suggestions not already declared, so re-deriving never duplicates what the user has edited.
 *
 * Matched on role, because that is the identity a descriptor has: two image inputs are told apart by
 * being `first_frame` and `style_reference` and by nothing else.
 */
export function missingConsumes(
  declared: readonly ConsumesDescriptor[],
  suggested: readonly ConsumesDescriptor[],
): readonly ConsumesDescriptor[] {
  const roles = new Set(declared.map((input) => input.role ?? ''));
  return suggested.filter((input) => !roles.has(input.role ?? ''));
}

/**
 * A descriptor with one field changed.
 *
 * A change object, so `undefined` means "leave it" — the codebase's rule everywhere a partial edit is
 * expressed. Clearing a role is not offered, because a descriptor without one cannot be matched to its
 * parameter and would silently stop carrying its sources.
 */
export interface ConsumesChange {
  readonly role?: string;
  readonly required?: boolean;
  readonly sources?: readonly TextSource[];
}

export function editConsumes(
  inputs: readonly ConsumesDescriptor[],
  index: number,
  change: ConsumesChange,
): readonly ConsumesDescriptor[] {
  return inputs.map((input, at) => {
    if (at !== index) return input;
    return {
      ...input,
      ...(change.role !== undefined && change.role.trim() !== '' ? { role: change.role } : {}),
      ...(change.required !== undefined ? { required: change.required } : {}),
      // Sources belong to text alone: writing them onto an image input would produce a manifest field
      // that every reader ignores and the next author has to explain away.
      ...(change.sources !== undefined && input.type === 'text' ? { sources: change.sources } : {}),
    };
  });
}

/** Removes one input, for a suggestion the graph turned out not to need. */
export function removeConsumes(
  inputs: readonly ConsumesDescriptor[],
  index: number,
): readonly ConsumesDescriptor[] {
  return inputs.filter((_input, at) => at !== index);
}

/**
 * Whether a declared input has a parameter to take its value from.
 *
 * Reported rather than corrected: an input with no matching parameter is not necessarily wrong — a
 * manifest may describe what it consumes before its parameters exist — but it *is* worth saying,
 * because the surfaces will be derived from something the panel cannot ask the user for.
 */
export function unmatchedConsumes(
  inputs: readonly ConsumesDescriptor[],
  params: readonly DraftParam[],
): readonly ConsumesDescriptor[] {
  const keys = new Set(params.map((param) => param.key));
  return inputs.filter((input) => input.role === undefined || !keys.has(input.role));
}
