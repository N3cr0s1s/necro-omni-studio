import { type CSSProperties, type KeyboardEvent, type ReactNode, useCallback, useMemo, useState } from 'react';
import type { AssetPath } from '@nos/core';
import {
  type DirectoryNode,
  type FileNode,
  type TreeNode,
  type WatcherStatus,
  formatBytes,
  isTimelineAsset,
} from '@nos/media';
import { Badge, Mono, PanelHeader, StatusDot } from '../primitives/Primitives.js';
import { assetSwatch, folderSwatch, token } from '../tokens/tokens.js';

/**
 * The media browser.
 *
 * Mirrors the real project folder rather than an imported-assets database — the spec's central
 * decision about what a project is. Consequences visible here:
 *
 * - The tree is a projection of the filesystem, so it must survive changes made outside the app. It
 *   is rendered from an immutable `DirectoryNode`; the owner rebuilds that from watcher batches and
 *   passes a new one in.
 * - Arbitrary files and subdirectories are legal. Anything the app cannot type still renders, with a
 *   neutral swatch, because the user put it there deliberately.
 * - Watcher state is shown. A silently dead watcher is worse than none: the user would trust a stale
 *   tree, and the spec's whole premise is that the folder is the truth.
 */

export interface MediaBrowserProps {
  readonly tree: DirectoryNode;
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
}

/** Folders open by default: the ones a user works in, not the derived ones. */
const DEFAULT_EXPANDED: readonly string[] = ['media', 'generated', 'notes'];

export function MediaBrowser({
  tree,
  watcher,
  selected,
  onSelect,
  onActivate,
  onDragStart,
  detail,
  onRescan,
}: MediaBrowserProps): ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(DEFAULT_EXPANDED),
  );

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
  const rows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  return (
    <div
      style={{
        width: token.browserWidth,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: token.bgPanel,
        borderRight: `1px solid ${token.border}`,
      }}
    >
      <PanelHeader
        caption="Project folder"
        trailing={<WatcherIndicator status={watcher} onRescan={onRescan} />}
      />

      <div
        role="tree"
        aria-label="Project folder"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: `${token.space2} 0`,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: token.space5 }}>
            <Mono tone={token.textGhost}>This project folder is empty</Mono>
          </div>
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
            />
          ))
        )}
      </div>

      {detail !== undefined && (
        <div
          style={{
            flex: 'none',
            borderTop: `1px solid ${token.borderSubtle}`,
            padding: `${token.space5} ${token.space5}`,
          }}
        >
          {detail}
        </div>
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
      <button
        type="button"
        onClick={onRescan}
        title={status.error.detail}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: token.space2,
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: onRescan === undefined ? 'default' : 'pointer',
        }}
      >
        <StatusDot color={token.danger} size={6} label="Watcher failed" />
        <Mono tone={token.danger}>rescan</Mono>
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: token.space2 }}>
      <StatusDot
        color={status.watching ? token.ok : token.textGhost}
        size={6}
        label={status.watching ? 'Watching for changes' : 'Not watching'}
      />
      <Mono tone={token.textFaint}>{status.watching ? 'watching' : 'idle'}</Mono>
    </div>
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

const INDENT_PX = 13;

function TreeRow({
  row,
  expanded,
  selected,
  onToggle,
  onSelect,
  onActivate,
  onDragStart,
}: {
  readonly row: Row;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly onToggle: (path: string) => void;
  readonly onSelect?: (path: AssetPath) => void;
  readonly onActivate?: (path: AssetPath) => void;
  readonly onDragStart?: (path: AssetPath) => void;
}): ReactNode {
  const { node, depth } = row;
  const isDirectory = node.kind === 'directory';
  const draggable = !isDirectory && isTimelineAsset(node.path);

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

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: token.space3,
    padding: `5px ${token.space5}`,
    paddingLeft: `calc(${token.space5} + ${depth * INDENT_PX}px)`,
    font: selected || isDirectory ? `500 12px ${token.fontUi}` : `400 12px ${token.fontUi}`,
    color: selected ? token.textBright : isDirectory ? token.textBright : token.textMuted,
    // A left border rather than a full outline for selection: it does not shift the row's contents,
    // so the list does not jitter as selection moves.
    borderLeft: selected ? `2px solid ${token.accent}` : '2px solid transparent',
    background: selected ? token.surfaceSelected : 'transparent',
    cursor: 'default',
    userSelect: 'none',
  };

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={isDirectory ? expanded : undefined}
      tabIndex={0}
      draggable={draggable}
      onClick={() => {
        if (isDirectory) onToggle(node.path);
        else onSelect?.(node.path as AssetPath);
      }}
      onDoubleClick={activate}
      onKeyDown={handleKeyDown}
      onDragStart={() => onDragStart?.(node.path as AssetPath)}
      style={rowStyle}
    >
      <span
        aria-hidden="true"
        style={{
          width: 10,
          flex: 'none',
          textAlign: 'center',
          color: isDirectory ? token.textSoft : token.textFaint,
          font: `400 10px ${token.fontUi}`,
        }}
      >
        {isDirectory ? (expanded ? '▾' : '▸') : '·'}
      </span>

      <span
        aria-hidden="true"
        style={{
          width: 9,
          height: 9,
          flex: 'none',
          borderRadius: 2,
          background: isDirectory
            ? folderSwatch(node.name)
            : assetSwatch((node as FileNode).assetType),
        }}
      />

      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {node.name}
      </span>

      <div style={{ flex: 1 }} />

      <RowMeta node={node} />
    </div>
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
      <span style={{ display: 'flex', alignItems: 'center', gap: token.space2 }}>
        {node.sizeBytes > 0 && <Mono tone={token.textGhost}>{formatBytes(node.sizeBytes)}</Mono>}
        <Mono tone={token.textGhost}>derived</Mono>
      </span>
    );
  }

  if (node.name === 'generated') {
    return <Mono tone={token.textFaint}>{formatBytes(node.sizeBytes)}</Mono>;
  }

  return node.fileCount > 0 ? <Mono tone={token.textGhost}>{node.fileCount}</Mono> : null;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: token.space2 }}>
        <span
          style={{
            font: `500 11.5px ${token.fontUi}`,
            color: isGenerated ? token.generatedText : token.textBright,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        {isGenerated && <Badge tone="generated">generated</Badge>}
      </div>

      {summary !== undefined && <Mono tone={token.textDim}>{summary}</Mono>}

      <div style={{ display: 'flex', alignItems: 'center', gap: token.space3, flexWrap: 'wrap' }}>
        <DerivedState label="proxy" ready={hasProxy} />
        <DerivedState label="filmstrip" ready={hasFilmstrip} />
        {hash !== undefined && <Mono tone={token.textGhost}>hash {hash.slice(0, 6)}…</Mono>}
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
  return (
    <Mono tone={ready ? token.ok : token.textGhost}>
      {label} {ready ? '✓' : '…'}
    </Mono>
  );
}
