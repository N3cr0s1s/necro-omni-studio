import type { ReactNode } from 'react';
import type { MarkdownBlock, MarkdownSpan } from '@nos/media';
import { cn } from '@nos/ui/lib/utils';

/**
 * A note, rendered.
 *
 * The spec's §4 asks for exactly this — "a markdownt a browser megjeleníti" — and it is the only
 * reason `notes/` is a reserved folder. Until now the browser showed a note's filename and nothing
 * else, which for `notes/2026-02-11.md` is no information at all.
 *
 * ## Two safety properties, and neither is incidental
 *
 * **No markup ever comes from the file.** The parser produces a structure and this emits React
 * elements from it; there is no `dangerouslySetInnerHTML` anywhere on the path from a note's bytes to
 * the screen. A note arrives from a client, a download or a generator, and treating it as markup would
 * make one a way to put arbitrary elements inside the editor's own DOM.
 *
 * **A link cannot navigate.** This renderer is the application: following a link in place would
 * replace the editor with a web page and lose unsaved work, with no back button — the window has no
 * chrome. Links are inert unless the caller supplies `onOpenLink`, which is expected to hand the URL
 * to the system browser through the desktop bridge.
 */

export interface NoteViewProps {
  readonly blocks: readonly MarkdownBlock[];
  /**
   * Opens a link somewhere that is not this window.
   *
   * Absent leaves links inert with their target in the tooltip, which is the safe default: a renderer
   * that navigated would take the editor with it.
   */
  readonly onOpenLink?: ((href: string) => void) | undefined;
  readonly className?: string | undefined;
}

/** Heading sizes, by depth. Only the top three differ; below that a heading is a bold line. */
const HEADING_CLASS: Readonly<Record<number, string>> = {
  1: 'text-sm font-semibold',
  2: 'text-[13px] font-semibold',
  3: 'text-xs font-semibold',
};

export function NoteView({ blocks, onOpenLink, className }: NoteViewProps): ReactNode {
  if (blocks.length === 0) {
    return <p className={cn('font-mono text-xs text-muted-foreground', className)}>this note is empty</p>;
  }

  return (
    <div className={cn('flex flex-col gap-2 text-xs leading-relaxed', className)}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} onOpenLink={onOpenLink} />
      ))}
    </div>
  );
}

function Block({
  block,
  onOpenLink,
}: {
  readonly block: MarkdownBlock;
  readonly onOpenLink: ((href: string) => void) | undefined;
}): ReactNode {
  switch (block.kind) {
    case 'heading':
      return (
        <p className={HEADING_CLASS[block.level] ?? 'text-xs font-semibold'}>
          <Spans spans={block.spans} onOpenLink={onOpenLink} />
        </p>
      );

    case 'paragraph':
      return (
        <p>
          <Spans spans={block.spans} onOpenLink={onOpenLink} />
        </p>
      );

    case 'list':
      return block.ordered ? (
        <ol className="list-decimal pl-4">
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} onOpenLink={onOpenLink} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc pl-4">
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} onOpenLink={onOpenLink} />
            </li>
          ))}
        </ul>
      );

    case 'quote':
      return (
        <blockquote className="border-l-2 pl-3 text-muted-foreground italic">
          <Spans spans={block.spans} onOpenLink={onOpenLink} />
        </blockquote>
      );

    case 'code':
      return (
        // `overflow-x-auto` rather than wrapping: a broken line of shader source is harder to read
        // than a scrolled one, and this panel is narrow.
        <pre className="overflow-x-auto rounded-md border bg-muted p-2 font-mono text-[11px]">
          <code>{block.text}</code>
        </pre>
      );

    case 'rule':
      return <hr className="border-border" />;

    default: {
      const unreachable: never = block;
      throw new Error(`Unhandled block ${JSON.stringify(unreachable)}`);
    }
  }
}

function Spans({
  spans,
  onOpenLink,
}: {
  readonly spans: readonly MarkdownSpan[];
  readonly onOpenLink: ((href: string) => void) | undefined;
}): ReactNode {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.kind) {
          case 'strong':
            return <strong key={index}>{span.text}</strong>;
          case 'emphasis':
            return <em key={index}>{span.text}</em>;
          case 'code':
            return (
              <code key={index} className="rounded-sm bg-muted px-1 font-mono text-[11px]">
                {span.text}
              </code>
            );
          case 'link':
            return (
              <a
                key={index}
                // No `href`. A missing one is what makes the anchor unfollowable by a middle click or
                // a keyboard activation as well as by a plain click — `preventDefault` alone would
                // stop only the last of those.
                title={span.href}
                role={onOpenLink === undefined ? undefined : 'link'}
                tabIndex={onOpenLink === undefined ? undefined : 0}
                className={cn('text-primary underline underline-offset-2', onOpenLink && 'cursor-pointer')}
                onClick={() => onOpenLink?.(span.href)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onOpenLink?.(span.href);
                }}
              >
                {span.text}
              </a>
            );
          default:
            return <span key={index}>{span.text}</span>;
        }
      })}
    </>
  );
}
