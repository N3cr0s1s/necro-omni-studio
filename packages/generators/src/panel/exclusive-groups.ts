import type { GeneratorManifest, GeneratorParam } from '../contracts/manifest.js';

/**
 * Parameters that are alternatives to one another.
 *
 * `interfaces.md` §2.3 settles this for text-to-speech: a voice is given *either* as an enum the
 * backend knows *or* as an audio sample to clone, "a kettő közül egyet kell megadni", and the UI shows
 * them as a mutually exclusive choice. Nothing expressed that, so a manifest declaring both rendered
 * two independent controls, invited the user to fill in both, and submitted both — leaving what the
 * graph does with the pair undefined.
 *
 * ## Declared, not inferred
 *
 * The specification describes the behaviour and not the mechanism. Inferring the pairing — two
 * parameters whose roles look related, or an optional asset next to an enum — would be guesswork that
 * silently groups things nobody meant to group. A manifest says which parameters are alternatives, and
 * a manifest that says nothing keeps exactly the behaviour it has today.
 *
 * Groups are a list of lists rather than a flag on a parameter because a generator may plausibly have
 * two independent either/or choices, and because a group carries its own `required`.
 */

export interface ExclusiveGroup {
  /** Parameter keys, in the order the chooser should offer them. */
  readonly members: readonly string[];
  /** Label for the chooser itself, e.g. "Voice". Falls back to the members' own labels. */
  readonly label?: string;
  /** Whether one of them must be given. §2.3's voice is required; the pair is not individually. */
  readonly required?: boolean;
}

/** The groups a manifest declares, dropping any that no longer describe real parameters. */
export function exclusiveGroupsOf(manifest: GeneratorManifest): readonly ExclusiveGroup[] {
  const keys = new Set(manifest.params.map((param) => param.key));

  return (
    (manifest.exclusive ?? [])
      .map((group) => ({ ...group, members: group.members.filter((member) => keys.has(member)) }))
      // A group of one is not a choice, and a group of none is a stale declaration. Both are dropped
      // rather than rejected: a manifest edited to remove a parameter should keep working.
      .filter((group) => group.members.length > 1)
  );
}

/** Whether this parameter is offered inside a group, so the panel does not also draw it on its own. */
export function isGrouped(groups: readonly ExclusiveGroup[], param: GeneratorParam): boolean {
  return groups.some((group) => group.members.includes(param.key));
}

/**
 * Which member currently holds the value.
 *
 * The first member with something set, in declaration order — so a manifest controls which alternative
 * a fresh panel opens on, and a recalled run opens on whichever one it actually used.
 *
 * `undefined` when none is set, which is a group that has not been answered yet rather than an error.
 */
export function activeMember(
  group: ExclusiveGroup,
  values: Readonly<Record<string, string | number | boolean>>,
): string | undefined {
  return group.members.find((member) => isSet(values[member]));
}

/**
 * The values with every other member of the group cleared.
 *
 * Choosing an alternative *removes* the others rather than leaving them behind, because a submit
 * carries whatever the parameters hold: a voice sample left over from a previous choice would still
 * reach the graph beside the enum the user has since picked, which is exactly the ambiguity the group
 * exists to prevent.
 */
export function selectMember(
  group: ExclusiveGroup,
  values: Readonly<Record<string, string | number | boolean>>,
  chosen: string,
): Readonly<Record<string, string | number | boolean>> {
  const next: Record<string, string | number | boolean> = { ...values };
  for (const member of group.members) {
    if (member !== chosen) delete next[member];
  }
  return next;
}

/** Groups that must be answered and have not been, so a run can be refused with a reason. */
export function unansweredGroups(
  groups: readonly ExclusiveGroup[],
  values: Readonly<Record<string, string | number | boolean>>,
): readonly ExclusiveGroup[] {
  return groups.filter((group) => group.required === true && activeMember(group, values) === undefined);
}

/** How a chooser names a group: its own label, or its members' keys joined. */
export function groupLabel(group: ExclusiveGroup, params: readonly GeneratorParam[]): string {
  if (group.label !== undefined && group.label.trim() !== '') return group.label;
  return group.members
    .map((member) => params.find((param) => param.key === member)?.label ?? member)
    .join(' or ');
}

/**
 * Whether a value counts as given.
 *
 * An empty string does not: a text field the user cleared has not chosen that alternative, and treating
 * it as an answer would let an empty script satisfy a required group. `false` does, because a boolean
 * alternative that is deliberately off is still the one that was picked.
 */
function isSet(value: string | number | boolean | undefined): boolean {
  if (value === undefined) return false;
  return typeof value === 'string' ? value.trim() !== '' : true;
}
