import { describe, expect, it } from 'vitest';
import { baseName, extensionOf, planImport, stemOf, uniqueName, uniquePath } from './import-name.js';

/**
 * Naming a file brought into a project.
 *
 * Importing means copying, because a link to somewhere else on the machine breaks §4's promise that
 * zipping the folder moves the project — invisibly, since the cut plays perfectly until it is opened
 * somewhere else. Copying means two files can want one name, and that is what this decides.
 */

describe('taking a name apart', () => {
  it('keeps the last extension, which is what other programs read', () => {
    expect(extensionOf('take.mp4')).toBe('.mp4');
    expect(extensionOf('archive.tar.gz')).toBe('.gz');
  });

  it('treats a leading dot as a hidden file rather than an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(stemOf('.gitignore')).toBe('.gitignore');
  });

  it('gives an extensionless name back whole', () => {
    expect(extensionOf('README')).toBe('');
    expect(stemOf('README')).toBe('README');
  });

  it('splits a name into the parts that go either side of the number', () => {
    expect(stemOf('take.mp4')).toBe('take');
  });
});

describe('finding a free name', () => {
  it('uses the name as given when nothing has it', () => {
    expect(uniqueName('take.mp4', new Set())).toBe('take.mp4');
  });

  it('numbers before the extension, so the copy is still openable', () => {
    // `take.mp4 (2)` is a file every other program would fail to recognise.
    expect(uniqueName('take.mp4', new Set(['take.mp4']))).toBe('take (2).mp4');
  });

  it('counts from two, because the file already there is the first', () => {
    expect(uniqueName('take.mp4', new Set(['take.mp4']))).toBe('take (2).mp4');
  });

  it('skips numbers already taken rather than giving up', () => {
    const taken = new Set(['take.mp4', 'take (2).mp4', 'take (3).mp4']);
    expect(uniqueName('take.mp4', taken)).toBe('take (4).mp4');
  });

  it('handles a name with no extension', () => {
    expect(uniqueName('README', new Set(['README']))).toBe('README (2)');
  });
});

describe('planning a batch', () => {
  it('puts each file in the folder asked for', () => {
    const plan = planImport(['/home/u/a.mp4', '/home/u/b.wav'], 'media', new Set());
    expect(plan.map((entry) => entry.to)).toEqual(['media/a.mp4', 'media/b.wav']);
  });

  it('keeps the source path exactly as the user chose it', () => {
    const plan = planImport(['/home/u/My Footage/a.mp4'], 'media', new Set());
    expect(plan[0]?.from).toBe('/home/u/My Footage/a.mp4');
  });

  it('separates two imports that want the same name as each other', () => {
    // Two cards each holding `shot.mp4` is a normal thing to import at once, and resolving names one
    // at a time against the folder alone would silently drop one of them.
    const plan = planImport(['/a/shot.mp4', '/b/shot.mp4'], 'media', new Set());
    expect(plan.map((entry) => entry.to)).toEqual(['media/shot.mp4', 'media/shot (2).mp4']);
  });

  it('separates them from what the folder already holds', () => {
    const plan = planImport(['/a/shot.mp4'], 'media', new Set(['shot.mp4']));
    expect(plan[0]?.to).toBe('media/shot (2).mp4');
  });

  it('imports into the project root when no folder is named', () => {
    expect(planImport(['/a/shot.mp4'], '', new Set())[0]?.to).toBe('shot.mp4');
  });

  it('reads a Windows path, so a chooser on either platform resolves', () => {
    expect(baseName('C:\\Users\\u\\shot.mp4')).toBe('shot.mp4');
    expect(baseName('/home/u/shot.mp4')).toBe('shot.mp4');
  });
});

describe('a free name for a delivery', () => {
  /**
   * Export is the one write in this application that used to destroy something without a word: the
   * encoder passes `-y` and the dialog offers the same path every time it opens, so a second export
   * replaced the first — minutes of GPU time and the only copy of a finished cut.
   */
  it('leaves a path nothing has taken', () => {
    expect(uniquePath('renders/cut.mp4', new Set())).toBe('renders/cut.mp4');
  });

  it('numbers before the extension, keeping the folder', () => {
    // `renders/cut.mp4 (2)` would be unopenable, and moving it to the root would hide it.
    expect(uniquePath('renders/cut.mp4', new Set(['renders/cut.mp4']))).toBe('renders/cut (2).mp4');
  });

  it('skips past every copy already there', () => {
    const taken = new Set(['renders/cut.mp4', 'renders/cut (2).mp4', 'renders/cut (3).mp4']);
    expect(uniquePath('renders/cut.mp4', taken)).toBe('renders/cut (4).mp4');
  });

  it('is not confused by the same name in another folder', () => {
    // The set is keyed by full path, so a candidate has to be re-qualified before it is tested —
    // otherwise `media/cut (2).mp4` would make `renders/cut (2).mp4` look taken.
    const taken = new Set(['renders/cut.mp4', 'media/cut (2).mp4']);
    expect(uniquePath('renders/cut.mp4', taken)).toBe('renders/cut (2).mp4');
  });

  it('works at the project root, where there is no folder to keep', () => {
    expect(uniquePath('cut.mp4', new Set(['cut.mp4']))).toBe('cut (2).mp4');
  });
});
