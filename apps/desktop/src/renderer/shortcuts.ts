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
 * The bindings live in four hooks, grouped here by what the user is doing rather than by which hook
 * owns the listener: nobody looking for "how do I nudge one frame" thinks of it as the transport's.
 *
 * - `use-transport.ts` — play, step, home
 * - `use-timeline-view.ts` — undo, redo, fit
 * - `use-clip-edits.ts` — the clipboard, split, enable, remove
 * - `use-work-range.ts` — marks and markers
 *
 * All four ignore keys while a text field has focus, which is why the sheet says so once rather than
 * repeating it on every row.
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
      { keys: ['Escape'], action: 'Clear the selection' },
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
      { keys: ['F'], action: 'Fit the sequence in the window' },
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
    ],
  },
];

/** The chord a menu should print for a command, from the same declaration the sheet draws. */
export function shortcutLabel(command: string): string | undefined {
  return shortcutFor(SHORTCUT_GROUPS, command);
}
