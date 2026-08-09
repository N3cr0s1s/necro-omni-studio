import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  FolderTreeIcon,
  RadioIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import type { AssetPath, AssetType } from '@nos/core';
import {
  type DirectoryNode,
  type FileNode,
  type TreeFilter,
  type TreeNode,
  type WatcherStatus,
  filterTree,
  formatBytes,
  isNarrowing,
  isTimelineAsset,
} from '@nos/media';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import { Input } from '@nos/ui/components/ui/input';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';
import { Separator } from '@nos/ui/components/ui/separator';
import { type MenuBinding, ActionMenu } from '../menus/ActionMenu.js';
import { cn } from '@nos/ui/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@nos/ui/components/ui/toggle-group';
import { assetGlyph } from '../semantics/glyphs.js';
import { AssetIcon } from './AssetIcon.js';

/**
 * The media browser.
 *
 * Mirrors the real project folder rather than an imported-assets database — the spec's central
 * decision about what a project is. Consequences visible here:
 *
 * - The tree is a projection of the filesystem, so it must survive changes made outside the app. It
 *   is rendered from an immutable `DirectoryNode`; the owner rebuilds that from watcher batches and
 *   passes a new one in.
 * - Arbitrary files and subdirectories are legal. Anything the app cannot type still renders, as a
 *   plain page, because the user put it there deliberately and "a file" is all this knows.
 * - Watcher state is shown. A silently dead watcher is worse than none: the user would trust a stale
 *   tree, and the spec's whole premise is that the folder is the truth.
 */

/** What a right-click in the browser was about. `path` is empty for the space below the rows. */
export interface BrowserMenuTarget {
  readonly path: string;
  readonly isDirectory: boolean;
}

export interface MediaBrowserProps {
  readonly tree: DirectoryNode;
  /**
   * Whether a project is open at all.
   *
   * The tree cannot carry this: an empty project and no project both arrive as a directory with no
   * children, and the browser said "this project folder is empty" for both — telling a user who has
   * not opened anything that the folder they do not have is empty.
   *
   * Optional and defaulting to open, so a caller that always has a project — every test, the harnesses
   * — does not have to say so.
   */
  readonly projectOpen?: boolean;
  readonly watcher: WatcherStatus;
  /** Currently selected asset, if any. */
  readonly selected?: AssetPath;
  readonly onSelect?: (path: AssetPath) => void;
  /** Double-click or Enter: insert at the playhead. */
  readonly onActivate?: (path: AssetPath) => void;
  /** Drag start, so the timeline can accept a drop. */
  readonly onDragStart?: (path: AssetPath) => void;
  /** Detail pane content for the selected asset. Injected so this component stays presentational. */
  readonly detail?: ReactNode;
  readonly onRescan?: () => void;

  /**
   * Organising the project from inside the browser.
   *
   * A project *is* a folder, and the browser could show one and do nothing to it: no way to make a
   * folder, rename a file, delete one or move anything. What each action *means* is the caller's —
   * this reports the gesture and renders the result.
   */
  readonly menu?: MenuBinding<BrowserMenuTarget>;
  /** Path whose inline name field should be open, for a rename asked for from the menu. */
  readonly renamingPath?: string;
  readonly onRename?: (path: string, name: string) => void;
  /** A row dropped onto a folder. Refusing the meaningless moves is the caller's job, not the DOM's. */
  readonly onMove?: (source: string, destinationFolder: string) => void;
}

/**
 * MIME type the browser puts an asset path on when a row is dragged.
 *
 * A custom type rather than `text/plain`: a drop target must be able to tell a project asset from a
 * fragment of text dragged in from another application, and refuse the second.
 */
export const ASSET_DRAG_TYPE = 'application/x-nos-asset';

/**
 * A drag that means "move this inside the project", distinct from the one a timeline accepts.
 *
 * Two types rather than one flag on a shared payload: the timeline must never accept a folder, and a
 * folder row must never accept a drag from outside the browser. Keeping them apart makes both
 * refusals structural instead of a condition somebody has to remember to write.
 */
export const MOVE_DRAG_TYPE = 'application/x-nos-move';

/** Paths the application depends on, which must not be dragged out of place. */
function isReservedPath(path: string): boolean {
  return path === 'project.json' || !path.includes('/');
}

/** Folders open by default: the ones a user works in, not the derived ones. */
const DEFAULT_EXPANDED: readonly string[] = ['media', 'generated', 'notes'];

export function MediaBrowser({
  tree,
  projectOpen,
  watcher,
  selected,
  onSelect,
  onActivate,
  onDragStart,
  detail,
  onRescan,
  menu,
  renamingPath,
  onRename,
  onMove,
}: MediaBrowserProps): ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(DEFAULT_EXPANDED));

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Flattened to a single list of visible rows. A flat list is what a tree widget needs for
  // roving-focus keyboard navigation, and it is also what a virtualized list would consume if the
  // project grows past what the DOM handles comfortably.
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement | null>(null);

  /*
   * `Ctrl+F` puts the caret in the filter, which is where every application that has one puts it.
   *
   * Owned here rather than by the shell because the control is here — a shortcut routed through a
   * prop would need the shell to hold a ref into this component to do anything with it.
   *
   * Deliberately not guarded against text fields: a user who is already typing in the filter and
   * reaches for `Ctrl+F` wants the box they are in, and selecting what is there is the useful answer.
   */
  useEffect(() => {
    // `globalThis.KeyboardEvent`, because React's own `KeyboardEvent` type is imported above and
    // shadows the DOM one that `window` actually hands out.
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'f' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      filterRef.current?.focus();
      filterRef.current?.select();
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const [kind, setKind] = useState<AssetType | undefined>(undefined);

  const filter: TreeFilter = { query, ...(kind !== undefined ? { assetType: kind } : {}) };
  const narrowed = isNarrowing(filter);
  const shown = useMemo(() => filterTree(tree, filter), [tree, query, kind]);

  /*
   * Everything opens while filtering.
   *
   * A match three folders down would otherwise be hidden behind the collapsed folders above it: the
   * user would type a name they can see in the finder, get a folder back, and conclude the search does
   * not work. The user's own expansion state is untouched and comes back the moment the box is empty.
   */
  const visible = useMemo(() => (narrowed ? allDirectories(shown) : expanded), [narrowed, shown, expanded]);

  const rows = useMemo(() => flattenVisible(shown, visible), [shown, visible]);

  // The menu for the empty space below the rows. This is what makes "New folder" reachable in a
  // project that has none — which is exactly when it is wanted.
  const background: BrowserMenuTarget = { path: '', isDirectory: false };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-9 flex-none items-center gap-3 px-4">
        <FolderTreeIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Project folder
        </span>
        <WatcherIndicator status={watcher} onRescan={onRescan} />
      </div>
      <Separator />

      <BrowserFilter
        inputRef={filterRef}
        query={query}
        onQuery={setQuery}
        kind={kind}
        onKind={setKind}
        showing={narrowed ? shown.fileCount : undefined}
        total={tree.fileCount}
      />

      <ActionMenu
        items={menu === undefined ? [] : menu.items(background)}
        onChoose={(action) => menu?.onChoose(background, action)}
      >
        <ScrollArea className="min-h-0 flex-1">
          <div role="tree" aria-label="Project folder" className="flex flex-col gap-px py-1">
            {rows.length === 0 ? (
              <p className="p-4 font-mono text-xs text-muted-foreground">
                {emptyMessage(projectOpen !== false, narrowed)}
              </p>
            ) : (
              rows.map((row) => (
                <TreeRow
                  key={row.node.path}
                  row={row}
                  expanded={row.node.kind === 'directory' && expanded.has(row.node.path)}
                  selected={selected === row.node.path}
                  onToggle={toggle}
                  {...(onSelect !== undefined ? { onSelect } : {})}
                  {...(onActivate !== undefined ? { onActivate } : {})}
                  {...(onDragStart !== undefined ? { onDragStart } : {})}
                  {...(menu !== undefined ? { menu } : {})}
                  {...(onRename !== undefined ? { onRename } : {})}
                  {...(onMove !== undefined ? { onMove } : {})}
                  renaming={renamingPath === row.node.path}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </ActionMenu>

      {detail !== undefined && (
        <>
          <Separator />
          <div className="flex-none p-4">{detail}</div>
        </>
      )}
    </div>
  );
}

/** Live watcher state, with a manual rescan when it has failed. */
function WatcherIndicator({
  status,
  onRescan,
}: {
  readonly status: WatcherStatus;
  readonly onRescan: (() => void) | undefined;
}): ReactNode {
  if (status.error !== undefined) {
    return (
      <Button
        variant="ghost"
        size="xs"
        onClick={onRescan}
        title={status.error.detail}
        aria-label="Watcher failed — rescan"
        className="ml-auto text-destructive"
      >
        <TriangleAlertIcon />
        <RefreshCwIcon />
        <span className="font-mono">rescan</span>
      </Button>
    );
  }

  return (
    <span
      className={cn(
        'ml-auto flex items-center gap-1.5 font-mono text-xs',
        status.watching ? 'text-muted-foreground' : 'text-muted-foreground/60',
      )}
      // Named rather than left to a coloured dot: a dead watcher means the tree is quietly stale, and
      // that is the one thing about this panel worth announcing.
      role="img"
      aria-label={status.watching ? 'Watching for changes' : 'Not watching'}
    >
      <RadioIcon className="size-3.5" />
      {status.watching ? 'watching' : 'idle'}
    </span>
  );
}

interface Row {
  readonly node: TreeNode;
  readonly depth: number;
}

/**
 * Produces the visible rows in display order.
 *
 * The root's own children sit at depth 0 — the root itself is the panel, not a row.
 */
/**
 * The box that narrows the folder, and the kinds beside it.
 *
 * At the top rather than in a menu: the reason it exists is a `generated/` folder holding forty takes
 * whose names differ in the middle, and a control you have to go looking for does not help with a list
 * you are already lost in.
 *
 * The kind toggles carry the same glyphs and the same `chart` roles the rows below them use, so the
 * filter and the thing filtered are recognisably about the same material.
 */
function BrowserFilter({
  inputRef,
  query,
  onQuery,
  kind,
  onKind,
  showing,
  total,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly onQuery: (value: string) => void;
  readonly kind: AssetType | undefined;
  readonly onKind: (value: AssetType | undefined) => void;
  /** Files after filtering. Absent when nothing is being filtered, so the count stays out of the way. */
  readonly showing: number | undefined;
  readonly total: number;
}): ReactNode {
  return (
    <div className="flex flex-none flex-col gap-1.5 px-2 py-1.5">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          // `Escape` clears rather than blurring: the box is a filter, and leaving a stale one applied
          // while the focus moves away is how a user ends up believing files have gone missing.
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            onQuery('');
            event.preventDefault();
            event.stopPropagation();
          }}
          aria-label="Filter the project folder"
          placeholder="Filter…"
          className="h-7 pr-7 pl-7 font-mono text-xs"
        />
        {query !== '' && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onQuery('')}
            aria-label="Clear the filter"
            className="absolute top-1/2 right-1 -translate-y-1/2"
          >
            <XIcon />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1">
        <ToggleGroup
          aria-label="Kind"
          value={kind === undefined ? [] : [kind]}
          onValueChange={(value) => onKind(value.at(-1) as AssetType | undefined)}
          className="gap-0.5"
        >
          {FILTERABLE_KINDS.map((type) => {
            const glyph = assetGlyph(type);
            return (
              <ToggleGroupItem
                key={type}
                value={type}
                aria-label={`Only ${glyph.label}`}
                title={`Only ${glyph.label}`}
                className="size-6"
              >
                <glyph.icon className={cn('size-3.5', kind === type ? undefined : glyph.tone)} />
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>

        {showing !== undefined && (
          <span className="ml-auto pr-1 font-mono text-[11px] text-muted-foreground tabular-nums">
            {showing} of {total}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The kinds worth offering.
 *
 * Not every `AssetType`: a project folder holds no `text` files, and a `mask` is cache rather than
 * material. Offering a filter that always returns nothing teaches the user the filter is broken.
 */
const FILTERABLE_KINDS: readonly AssetType[] = ['video', 'image', 'audio'];

/** Every folder in a tree, for the expansion a filter forces. */
function allDirectories(root: DirectoryNode): ReadonlySet<string> {
  const paths = new Set<string>();
  const walk = (node: DirectoryNode): void => {
    for (const child of node.children) {
      if (child.kind !== 'directory') continue;
      paths.add(child.path);
      walk(child);
    }
  };
  walk(root);
  return paths;
}

function flattenVisible(root: DirectoryNode, expanded: ReadonlySet<string>): readonly Row[] {
  const rows: Row[] = [];

  const walk = (node: DirectoryNode, depth: number): void => {
    for (const child of node.children) {
      rows.push({ node: child, depth });
      if (child.kind === 'directory' && expanded.has(child.path)) {
        walk(child, depth + 1);
      }
    }
  };

  walk(root, 0);
  return rows;
}

const INDENT_PX = 15;

function TreeRow({
  row,
  expanded,
  selected,
  onToggle,
  onSelect,
  onActivate,
  onDragStart,
  menu,
  renaming = false,
  onRename,
  onMove,
}: {
  readonly row: Row;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly onToggle: (path: string) => void;
  readonly onSelect?: (path: AssetPath) => void;
  readonly onActivate?: (path: AssetPath) => void;
  readonly onDragStart?: (path: AssetPath) => void;
  readonly menu?: MenuBinding<BrowserMenuTarget>;
  /** Open the inline name field for this row, for a rename asked for from the menu. */
  readonly renaming?: boolean;
  readonly onRename?: (path: string, name: string) => void;
  /** Reports a drop of `source` onto this folder. Folders only; files are not containers. */
  readonly onMove?: (source: string, destinationFolder: string) => void;
}): ReactNode {
  const { node, depth } = row;
  const [dropping, setDropping] = useState(false);
  const isDirectory = node.kind === 'directory';
  // Files that a timeline accepts drag as assets; everything else drags only to be moved, which is
  // why the browser's own drag type exists separately from the timeline's.
  const draggable = !isDirectory && isTimelineAsset(node.path);
  const movable = onMove !== undefined && !isReservedPath(node.path);
  const target: BrowserMenuTarget = { path: node.path, isDirectory };

  const activate = (): void => {
    if (isDirectory) {
      onToggle(node.path);
      return;
    }
    onActivate?.(node.path as AssetPath);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Arrow keys follow the standard tree pattern: Right opens, Left closes. Vertical movement is
    // left to the browser's own focus order, which matches the flattened row list.
    if (event.key === 'Enter') {
      event.preventDefault();
      activate();
    } else if (event.key === 'ArrowRight' && isDirectory && !expanded) {
      event.preventDefault();
      onToggle(node.path);
    } else if (event.key === 'ArrowLeft' && isDirectory && expanded) {
      event.preventDefault();
      onToggle(node.path);
    }
  };

  const Chevron = isDirectory ? (expanded ? ChevronDownIcon : ChevronRightIcon) : undefined;

  return (
    <ActionMenu
      items={menu === undefined ? [] : menu.items(target)}
      onChoose={(action) => menu?.onChoose(target, action)}
    >
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        aria-expanded={isDirectory ? expanded : undefined}
        tabIndex={0}
        draggable={draggable || movable}
        onContextMenu={() => {
          // Selecting first, like the timeline's menu: acting on something other than what was clicked
          // is the one behaviour a context menu must never have. Opening the menu itself is Base UI's,
          // and this handler runs alongside it rather than instead of it.
          if (!isDirectory) onSelect?.(node.path as AssetPath);
        }}
        onClick={() => {
          if (isDirectory) onToggle(node.path);
          else onSelect?.(node.path as AssetPath);
        }}
        onDoubleClick={activate}
        onKeyDown={handleKeyDown}
        onDragStart={(event) => {
          // The path travels on the drag itself rather than in application state, so a drop knows what
          // it received without the two sides having to agree on a variable a cancelled drag would
          // leave stale. Both types are set: the timeline reads one, a folder row the other, and which
          // one a drop honours is the drop target's business rather than the source's.
          if (draggable) event.dataTransfer.setData(ASSET_DRAG_TYPE, node.path);
          if (movable) event.dataTransfer.setData(MOVE_DRAG_TYPE, node.path);
          event.dataTransfer.effectAllowed = draggable ? 'copyMove' : 'move';
          onDragStart?.(node.path as AssetPath);
        }}
        onDragOver={(event) => {
          // Folders only. A file is not a container, and an inviting highlight on one would promise
          // something that cannot happen.
          if (!isDirectory || onMove === undefined) return;
          if (!event.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!isDirectory || onMove === undefined) return;
          const source = event.dataTransfer.getData(MOVE_DRAG_TYPE);
          if (source === '') return;
          event.preventDefault();
          onMove(source, node.path);
        }}
        className={cn(
          // Roomier than it was, on a direct report that the browser was hard to read — "everything is
          // tiny, I have to squint". This is the panel a user scans hundreds of times an hour, and a row
          // that takes three more pixels costs one row of scroll and buys legibility on every one of them.
          'flex cursor-default items-center gap-2 py-1.5 pr-4 text-sm select-none',
          // A left border rather than a full outline for selection: it does not shift the row's
          // contents, so the list does not jitter as selection moves.
          'border-l-2 border-transparent',
          (selected || isDirectory) && 'font-semibold',
          !selected && !isDirectory && 'text-muted-foreground',
          selected && 'border-l-primary bg-accent',
          dropping && 'bg-primary/15 ring-1 ring-primary',
        )}
        style={{ paddingLeft: 16 + depth * INDENT_PX }}
      >
        <span aria-hidden="true" className="w-2.5 flex-none text-muted-foreground">
          {Chevron !== undefined && <Chevron className="size-2.5" />}
        </span>

        {/* A glyph as well as the colour: a coloured square said there were four kinds of thing
            without saying which was which, and nothing in the window taught the palette. */}
        <AssetIcon
          className="size-4"
          isDirectory={isDirectory}
          name={node.name}
          open={expanded}
          {...(isDirectory ? {} : { assetType: (node as FileNode).assetType })}
        />

        {renaming && onRename !== undefined ? (
          <RowNameField name={node.name} onCommit={(name) => onRename(node.path, name)} />
        ) : (
          <span className="truncate">{node.name}</span>
        )}

        <RowMeta node={node} />
      </div>
    </ActionMenu>
  );
}

/**
 * The inline name field, for a rename asked for from the context menu.
 *
 * Enter commits and Escape abandons, which is what an inline rename does everywhere; a field that
 * could only be left by clicking elsewhere would leave the user unsure whether their change took.
 * The extension is left selected out of the initial selection, because renaming `take.mp4` almost
 * never means renaming it to something without `.mp4`.
 */
function RowNameField({
  name,
  onCommit,
}: {
  readonly name: string;
  readonly onCommit: (name: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState(name);

  return (
    <Input
      autoFocus
      aria-label={`Rename ${name}`}
      value={draft}
      onFocus={(event) => {
        const dot = name.lastIndexOf('.');
        event.target.setSelectionRange(0, dot > 0 ? dot : name.length);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(draft);
        else if (event.key === 'Escape') onCommit(name);
        else return;
        event.preventDefault();
      }}
      className="h-6 min-w-0 flex-1 px-1 py-0"
    />
  );
}

/**
 * Trailing metadata.
 *
 * Directories show what the user needs to decide something: `generated/` its size (the spec has no
 * retention policy, so the user cleans it by hand), the others their item count. `cache/` is
 * labelled derived so it reads as safe to delete.
 */
function RowMeta({ node }: { readonly node: TreeNode }): ReactNode {
  if (node.kind === 'file') {
    return null;
  }

  if (node.name === 'cache') {
    return (
      <span className="ml-auto flex items-center gap-2 font-mono text-xs text-muted-foreground">
        {node.sizeBytes > 0 && <span>{formatBytes(node.sizeBytes)}</span>}
        <span>derived</span>
      </span>
    );
  }

  if (node.name === 'generated') {
    return (
      <span className="ml-auto font-mono text-xs text-muted-foreground">{formatBytes(node.sizeBytes)}</span>
    );
  }

  return node.fileCount > 0 ? (
    <span className="ml-auto font-mono text-xs text-muted-foreground">{node.fileCount}</span>
  ) : null;
}

/**
 * Detail pane for a selected asset.
 *
 * Reports which derived artifacts exist, because the spec requires the user to be able to tell
 * whether a clip will play back smoothly. A missing proxy is not an error — it is work not yet done —
 * so it renders as a pending state rather than a failure.
 */
export interface AssetDetailProps {
  readonly name: string;
  /** `1920×1080 · 29.97 · 00:00:42:11` — already formatted by the caller. */
  readonly summary?: string;
  readonly hash?: string;
  readonly hasProxy?: boolean;
  readonly hasFilmstrip?: boolean;
  readonly isGenerated?: boolean;
}

export function AssetDetail({
  name,
  summary,
  hash,
  hasProxy,
  hasFilmstrip,
  isGenerated = false,
}: AssetDetailProps): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className={cn('truncate text-sm font-medium', isGenerated && 'text-chart-4')}>{name}</span>
        {isGenerated && (
          <Badge variant="secondary" className="text-chart-4">
            generated
          </Badge>
        )}
      </div>

      {summary !== undefined && <p className="font-mono text-xs text-muted-foreground">{summary}</p>}

      <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
        <DerivedState label="proxy" ready={hasProxy} />
        <DerivedState label="filmstrip" ready={hasFilmstrip} />
        {hash !== undefined && <span>hash {hash.slice(0, 6)}…</span>}
      </div>
    </div>
  );
}

function DerivedState({
  label,
  ready,
}: {
  readonly label: string;
  readonly ready: boolean | undefined;
}): ReactNode {
  if (ready === undefined) return null;
  const Icon = ready ? CircleCheckIcon : CircleDashedIcon;
  return (
    <span className={cn('flex items-center gap-1', ready && 'text-chart-2')}>
      <Icon className="size-3" />
      {label}
    </span>
  );
}

/**
 * What to say when there are no rows.
 *
 * Three different facts, and they were two: an empty project and no project at all both produced "this
 * project folder is empty", which tells someone who has opened nothing that the folder they do not
 * have is empty. The filter's own emptiness is a fourth thing again and already said so.
 *
 * Kept beside the component rather than passed in, so the wording has one home; the *fact* comes from
 * the shell, which is the only part that knows whether a project is open.
 */
function emptyMessage(projectOpen: boolean, narrowed: boolean): string {
  if (!projectOpen) return 'no project open — open one to see its files';
  return narrowed ? 'nothing here matches' : 'this project folder is empty';
}
