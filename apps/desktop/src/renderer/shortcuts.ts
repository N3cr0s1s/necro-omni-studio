import type { ShortcutGroup } from '@nos/ui';
import { shortcutFor } from '@nos/ui';

/**
 * What this editor binds.
 *
 * The catalogue lives here rather than in `@nos/ui` because *which* key does what is an application
 * decision — the library knows how to draw a binding and nothing about `S` splitting a clip.
 *
 * Every entry was read off the handler that implements it. That matters more than it sounds: a
 * reference sheet is believed, so one that lists a chord nothing listens for is worse than no sheet
 * at all — the user presses it, nothing happens, and they stop trusting the rest of the page.
 *
 * The bindings live in five hooks, grouped here by what the user is doing rather than by which hook
 * owns the listener: nobody looking for "how do I nudge one frame" thinks of it as the transport's.
 *
 * - `use-transport.ts` — play, step, home
 * - `use-timeline-view.ts` — undo, redo, fit
 * - `use-clip-edits.ts` — the clipboard, split, enable, remove
 * - `use-work-range.ts` — marks and markers
 * - `use-mode-keys.ts` — snap, ripple, loop
 *
 * All five ignore keys while a text field has focus, which is why the sheet says so once rather than
 * repeating it on every row.
 *
 * The last group is different in kind and says so: those keys belong to a **focused element** rather
 * than to the window. They were left out for exactly the reason `Alt`-drag was once left out — the
 * bindings existed, worked, and were reachable only by someone who had read the source. A keyframe's
 * value could be nudged from the keyboard and an effect reordered without a pointer, and nothing
 * anywhere said so.
 */

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Playback',
    shortcuts: [
      { keys: ['Space'], action: 'Play or pause' },
      { keys: ['←'], action: 'Step back one frame' },
      { keys: ['→'], action: 'Step forward one frame' },
      { keys: ['Shift', '←'], action: 'Step back ten frames' },
      { keys: ['Shift', '→'], action: 'Step forward ten frames' },
      { keys: ['Home'], action: 'Go to the start' },
      { keys: ['End'], action: 'Go to the end', note: 'the last frame, not past it' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: ['S'], action: 'Split at the playhead', command: 'split', note: 'the selected clip' },
      { keys: ['Shift', 'S'], action: 'Split every track at the playhead' },
      { keys: ['E'], action: 'Enable or disable', command: 'toggle-enabled', note: 'the selection' },
      { keys: ['Delete'], action: 'Remove', command: 'remove', note: 'ripple, if it is on' },
      { keys: ['Shift', 'Delete'], action: 'Remove the other way', note: 'ripple, if it is off' },
      {
        keys: ['G'],
        action: 'Close the gap before the clip',
        command: 'close-gap',
        note: 'the one frame of black you cannot see',
      },
      {
        keys: ['Shift', 'F'],
        action: 'Crossfade at the cut',
        command: 'crossfade-at-cut',
        note: 'grows both clips into their handles, so the cut keeps its timing',
      },
      { keys: ['Escape'], action: 'Clear the selection' },
    ],
  },
  {
    /*
     * The switches, which had no keys at all — while the Snap toggle's own tooltip said `Snap (N)`.
     * A control naming a chord nothing listens for is the exact failure this sheet exists to prevent,
     * committed by the application itself.
     */
    title: 'Modes',
    shortcuts: [
      { keys: ['N'], action: 'Snap on or off', note: 'edges, markers, the playhead' },
      { keys: ['R'], action: 'Ripple on or off', note: 'what Delete does' },
      { keys: ['L'], action: 'Loop on or off', note: 'return to the in point instead of stopping' },
    ],
  },
  {
    title: 'Clipboard',
    shortcuts: [
      { keys: ['Ctrl', 'X'], action: 'Cut', command: 'cut' },
      { keys: ['Ctrl', 'C'], action: 'Copy', command: 'copy' },
      { keys: ['Ctrl', 'V'], action: 'Paste', command: 'paste' },
      { keys: ['Ctrl', 'D'], action: 'Duplicate', command: 'duplicate' },
      { keys: ['Ctrl', 'A'], action: 'Select every clip' },
      { keys: [','], action: 'Nudge back one frame', note: 'the selected clip' },
      { keys: ['.'], action: 'Nudge forward one frame', note: 'the selected clip' },
      {
        keys: ['Ctrl', 'Shift', 'C'],
        action: 'Copy the look',
        command: 'copy-attributes',
        note: 'effects and transform',
      },
      { keys: ['Ctrl', 'Shift', 'V'], action: 'Paste the look', command: 'paste-attributes' },
    ],
  },
  {
    title: 'History and view',
    shortcuts: [
      { keys: ['Ctrl', 'Z'], action: 'Undo' },
      { keys: ['Ctrl', 'Shift', 'Z'], action: 'Redo' },
      { keys: ['Ctrl', 'Y'], action: 'Redo', note: 'the other spelling' },
      {
        keys: ['F'],
        action: 'Fit in the window',
        note: 'the selection, or the marked range, or everything',
      },
      { keys: ['='], action: 'Zoom in', note: 'about the middle of the view' },
      { keys: ['-'], action: 'Zoom out' },
      { keys: ['?'], action: 'Show this list' },
      { keys: ['Ctrl', 'F'], action: 'Filter the project folder' },
      { keys: ['Ctrl', 'S'], action: 'Save the project' },
    ],
  },
  {
    title: 'Range and markers',
    shortcuts: [
      { keys: ['I'], action: 'Mark in' },
      { keys: ['O'], action: 'Mark out' },
      { keys: ['Alt', 'X'], action: 'Clear the marked range' },
      { keys: ['M'], action: 'Add a marker at the playhead' },
      { keys: ['Alt', 'M'], action: 'Remove the marker here' },
      { keys: ['Alt', '←'], action: 'Go to the previous marker' },
      { keys: ['Alt', '→'], action: 'Go to the next marker' },
    ],
  },
  {
    /*
     * Three groups rather than one "focused item", because they are three listeners.
     *
     * A marker and the variant picker both want `Enter`, and lumping them under one scope would have
     * hidden that from the collision check — which is the only reason the check is worth running. They
     * do nothing until the thing they act on has been clicked or tabbed to, which is what the scope
     * says and why they are not folded into Editing above.
     */
    title: 'Keyframe marker',
    scope: 'keyframe',
    shortcuts: [
      { keys: ['←'], action: 'Move one frame', note: 'Shift for ten' },
      { keys: ['→'], action: 'Move one frame later' },
      { keys: ['↑'], action: 'Raise the value', note: 'a hundredth of the lane per press' },
      { keys: ['↓'], action: 'Lower the value' },
      { keys: ['Enter'], action: 'Cycle the easing', note: 'Space does the same' },
      { keys: ['Delete'], action: 'Remove the marker', note: 'Backspace too' },
    ],
  },
  {
    title: 'Effect stack row',
    scope: 'effect-stack',
    shortcuts: [
      {
        keys: ['Alt', '↑'],
        action: 'Move the effect up',
        note: 'the only way to reorder without a pointer, and order is render order',
      },
      { keys: ['Alt', '↓'], action: 'Move the effect down' },
    ],
  },
  {
    title: 'Variant picker',
    scope: 'variants',
    shortcuts: [
      { keys: ['←'], action: 'Compare the previous variant' },
      { keys: ['→'], action: 'Compare the next variant' },
      { keys: ['Enter'], action: 'Keep the one being auditioned' },
      { keys: ['Escape'], action: 'Stop showing the takes', note: 'the files stay in the project' },
    ],
  },
  {
    /*
     * The group this whole sheet exists for.
     *
     * `Alt`-drag is the spec's *csúsztatás* and there is no other way to perform it — no menu entry,
     * no toolbar button, nothing on the clip that hints at it. It was fully implemented and, for
     * anyone who had not read the source, unreachable.
     */
    title: 'Pointer',
    shortcuts: [
      { keys: ['Drag'], action: 'Move a clip', note: 'from its body' },
      { keys: ['Drag'], action: 'Scrub', note: 'on the ruler — audible unless turned off' },
      { keys: ['Alt', 'Drag'], action: 'Slip a clip', note: 'the content moves, the clip does not' },
      { keys: ['Drag'], action: 'Trim', note: 'from a clip edge' },
      { keys: ['Shift', 'Drag'], action: 'Roll a cut', note: 'from a shared edge' },
      { keys: ['Double-click'], action: 'Rename', note: 'a track or clip name' },
      { keys: ['Double-click'], action: 'Add a keyframe', note: 'on a parameter lane' },
      { keys: ['Double-click'], action: 'Name or colour a marker', note: 'on a ruler flag' },
      {
        keys: ['Ctrl', 'Wheel'],
        action: 'Zoom the preview',
        note: 'held, because a bare wheel scrolls the panel',
      },
      { keys: ['Middle-drag'], action: 'Pan the preview', note: 'the other buttons place and menu' },
      { keys: ['Double-click'], action: 'Back to fit', note: 'on the preview' },
    ],
  },
];

/** The chord a menu should print for a command, from the same declaration the sheet draws. */
export function shortcutLabel(command: string): string | undefined {
  return shortcutFor(SHORTCUT_GROUPS, command);
}
