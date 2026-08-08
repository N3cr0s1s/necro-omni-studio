import type { LucideIcon } from 'lucide-react';
import {
  AudioLinesIcon,
  ClapperboardIcon,
  CpuIcon,
  DatabaseIcon,
  FileIcon,
  FilmIcon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
  NotebookPenIcon,
  PackageIcon,
  SparklesIcon,
  SquareDashedIcon,
  TypeIcon,
  WandSparklesIcon,
} from 'lucide-react';
import type { AssetType } from '@nos/media';

/**
 * What a domain concept looks like.
 *
 * The one place where an asset type, a track kind or a reserved folder is turned into something
 * visible. It exists so the rule "purple means a generator made this" — or in shadcn's vocabulary,
 * "`chart-4` means a generator made this" — cannot be applied one way in the timeline and another way
 * in the browser.
 *
 * ## Why colour is a class name and not a value
 *
 * `tone` is a complete Tailwind class, written out in full, rather than a role name that a caller
 * interpolates into `text-${tone}`. Two reasons, and both are practical: Tailwind extracts class names
 * by scanning source text, so an interpolated name is one it never sees and never compiles; and a
 * literal class resolves through the shadcn palette, which means it changes with the theme and in dark
 * mode without anything here knowing that dark mode exists.
 *
 * The palette used is the categorical one — `chart-1` … `chart-5` — because that is precisely what it
 * is for. Asset types are categories, not states, so they must not borrow `primary` or `destructive`,
 * whose meanings are already taken.
 */
export interface Glyph {
  /** Drawn at whatever size the call site asks for; none is baked in. */
  readonly icon: LucideIcon;
  /**
   * Drawn instead of `icon` when the thing is expanded, where that means something.
   *
   * Only folders have one today. Absent means the glyph does not change with state, which is the
   * common case and must not require every call site to ask whether it does.
   */
  readonly openIcon?: LucideIcon;
  /** A shadcn text-colour utility, in full. Never a literal colour. */
  readonly tone: string;
  /** Accessible name, for the places a glyph appears without adjacent text. */
  readonly label: string;
}

/**
 * Glyph for an asset type.
 *
 * An unknown type gets the neutral file glyph rather than nothing at all: the project folder is
 * allowed to contain arbitrary files, and a file the application cannot classify is still a file the
 * user chose to put there.
 */
export function assetGlyph(type: AssetType | undefined): Glyph {
  switch (type) {
    case 'video':
      return { icon: FilmIcon, tone: 'text-chart-1', label: 'video' };
    case 'audio':
      return { icon: AudioLinesIcon, tone: 'text-chart-2', label: 'audio' };
    case 'image':
      return { icon: ImageIcon, tone: 'text-chart-3', label: 'image' };
    case 'text':
      return { icon: TypeIcon, tone: 'text-chart-5', label: 'text' };
    case 'mask':
      return { icon: SquareDashedIcon, tone: 'text-chart-4', label: 'mask' };
    default:
      return { icon: FileIcon, tone: 'text-muted-foreground', label: 'file' };
  }
}

/**
 * Glyph for one of the reserved project folders.
 *
 * These carry meaning rather than a file type, so they are drawn by what is in them: `generated/`
 * shares the generator glyph, `cache/` is muted because it is derived and disposable, and a folder the
 * application does not reserve gets the plain folder icon.
 */
export function folderGlyph(name: string): Glyph {
  switch (name) {
    case 'media':
      return { icon: ClapperboardIcon, tone: 'text-chart-1', label: 'media' };
    case 'generated':
      return { icon: SparklesIcon, tone: 'text-chart-4', label: 'generated' };
    case 'masks':
      return { icon: SquareDashedIcon, tone: 'text-chart-4', label: 'masks' };
    case 'effects':
      return { icon: WandSparklesIcon, tone: 'text-chart-2', label: 'effects' };
    case 'generators':
      return { icon: CpuIcon, tone: 'text-chart-4', label: 'generators' };
    case 'notes':
      return { icon: NotebookPenIcon, tone: 'text-chart-5', label: 'notes' };
    case 'renders':
      return { icon: PackageIcon, tone: 'text-chart-3', label: 'renders' };
    case 'cache':
      return { icon: DatabaseIcon, tone: 'text-muted-foreground', label: 'cache' };
    default:
      return { icon: FolderIcon, openIcon: FolderOpenIcon, tone: 'text-muted-foreground', label: name };
  }
}

/**
 * Whether a clip should be drawn as generated.
 *
 * A predicate rather than a field so that the answer is derived in one place. It reads as a tautology
 * today, and that is the point: the *rule* is "provenance is what makes a clip generated", and when
 * that rule grows a second condition there is one function to change.
 */
export function isGeneratedTreatment(hasProvenance: boolean): boolean {
  return hasProvenance;
}
