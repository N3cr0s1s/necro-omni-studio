import type { CapabilityOptions } from '../contracts/manifest.js';
import type { DraftParam } from './manifest-draft.js';

/**
 * What an enum parameter offers, and how it is edited.
 *
 * A manifest gives an enum its choices one of two ways, and the project uses both: a fixed list
 * written into the file, or a source the backend answers for — `{ from: 'capabilities' }`, naming a
 * node class and one of its inputs, which is how the sampler, scheduler, LoRA and aspect-ratio
 * dropdowns are filled in the shipped manifests.
 *
 * The inspector offered `enum` in its type list and had no field for either. Choosing it produced
 * "an enum needs options" with nothing on screen that could clear the error, and Save stays disabled
 * while a draft has errors — so the type was reachable and the parameter was not finishable. This
 * module is the half of the fix that can be tested without a DOM.
 *
 * ## Why the two shapes are one control
 *
 * They answer the same question — *where do the choices come from* — so making them one control with
 * a mode is what lets a user change their mind. Two separate fields would let a parameter carry both
 * at once, and the file format has no meaning for that.
 */

/** Which way an enum's choices are supplied. */
export type ChoiceMode = 'list' | 'capabilities';

/**
 * Whether the options name a source rather than a list.
 *
 * A written-out predicate because `Array.isArray` does not narrow a `readonly string[]` out of this
 * union — it is typed for mutable arrays, so the negative branch keeps both members and every field
 * access below would be an error. Saying it once here is better than an assertion at each use.
 */
export function isCapabilitySource(options: DraftParam['options']): options is CapabilityOptions {
  return options !== undefined && !Array.isArray(options);
}

export function choiceMode(options: DraftParam['options']): ChoiceMode {
  // A list by default, including for a parameter that has no options yet: it is the shape someone
  // typing a new enum almost always wants, and the other is one click away.
  return isCapabilitySource(options) ? 'capabilities' : 'list';
}

/**
 * The fixed list as one editable line, or empty.
 *
 * Comma-separated, which is how these read in the manifests themselves, and how someone pasting a
 * list out of ComfyUI will have it.
 */
export function choicesAsText(options: DraftParam['options']): string {
  return Array.isArray(options) ? options.join(', ') : '';
}

/**
 * A typed line back into a list.
 *
 * Empty entries are dropped rather than kept, so a trailing comma while typing does not add a choice
 * called nothing — which would then be selectable, and would submit an empty value to the graph.
 * Order is preserved and duplicates are not merged: a manifest author who writes the same value twice
 * has made a mistake worth seeing rather than one worth hiding.
 */
export function parseChoices(text: string): readonly string[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** The capability source, with blank fields where nothing is named yet. */
export function capabilitySource(options: DraftParam['options']): {
  readonly nodeClass: string;
  readonly input: string;
} {
  if (!isCapabilitySource(options)) return { nodeClass: '', input: '' };
  return { nodeClass: options.nodeClass ?? '', input: options.input ?? '' };
}

/**
 * The options value for a capability source.
 *
 * A blank field is omitted rather than written as an empty string, because the file format's absent
 * and empty mean different things: absent asks the backend for whatever it has, and `""` names a node
 * class called nothing, which never resolves.
 */
export function toCapabilityOptions(nodeClass: string, input: string): CapabilityOptions {
  return {
    from: 'capabilities',
    ...(nodeClass.trim() === '' ? {} : { nodeClass: nodeClass.trim() }),
    ...(input.trim() === '' ? {} : { input: input.trim() }),
  };
}

/**
 * The options value when the mode changes, keeping whatever survives the change.
 *
 * Switching away and back would otherwise silently empty a list someone had typed. Nothing carries
 * across — a list of sampler names is not a node class — so what is kept is the *shape*: switching to
 * capabilities yields a source with nothing named yet, and switching to a list yields an empty list
 * rather than `undefined`, so the field renders as an empty list and not as "no choices at all".
 */
export function optionsForMode(mode: ChoiceMode, current: DraftParam['options']): DraftParam['options'] {
  if (mode === choiceMode(current)) return current;
  return mode === 'capabilities' ? { from: 'capabilities' } : [];
}

/** What the parameter row says an enum will offer, for a reader scanning the list. */
export function describeChoices(options: DraftParam['options']): string {
  if (options === undefined) return 'no choices yet';
  if (!isCapabilitySource(options)) {
    if (options.length === 0) return 'no choices yet';
    return options.length === 1 ? '1 choice' : `${options.length} choices`;
  }

  const named = [options.nodeClass, options.input].filter((part) => part !== undefined);
  // Named where it can be: "from the backend" alone leaves someone with a wrong list no way to see
  // which node it came from.
  return named.length === 0 ? 'from the backend' : `from the backend · ${named.join(' · ')}`;
}
