import type { ReactNode } from 'react';
import { Kbd, KbdGroup } from '@nos/ui/components/ui/kbd';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nos/ui/components/ui/dialog';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';
import { Separator } from '@nos/ui/components/ui/separator';
import type { ShortcutGroup } from './shortcuts.js';

/**
 * Every binding, in one place a user can actually reach.
 *
 * The application is built to be driven from the keyboard — `S` splits, `I` and `O` mark a range, the
 * arrows step a frame at a time — and none of it was written down anywhere except in the source. The
 * clip menu printed the handful of chords that happened to have menu entries; the transport keys, the
 * range keys and the pointer gestures had nothing at all.
 *
 * The worst of those is `Alt`-drag. It is how the spec's *csúsztatás* is performed, it is the only way
 * to reach it, and there is no affordance on screen that hints it exists — so a feature that is fully
 * built was, in practice, unreachable by anyone who had not read `App.tsx`.
 *
 * Grouped by what the user is doing rather than by which module binds the key: nobody looking for "how
 * do I nudge a frame" thinks of it as belonging to the transport.
 */

export interface ShortcutSheetProps {
  readonly groups: readonly ShortcutGroup[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ShortcutSheet({ groups, open, onOpenChange }: ShortcutSheetProps): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard and pointer</DialogTitle>
          <DialogDescription>
            Everything the editor binds. Keys do nothing while a text field has focus.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-3">
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <section key={group.title} className="flex flex-col gap-2">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group.title}
                </h3>
                <Separator />
                <dl className="flex flex-col">
                  {group.shortcuts.map((shortcut) => (
                    <div key={`${group.title}:${shortcut.action}`} className="flex items-baseline gap-3 py-1">
                      <dt className="flex-none">
                        <KbdGroup>
                          {shortcut.keys.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </KbdGroup>
                      </dt>
                      <dd className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
                        <span className="truncate">{shortcut.action}</span>
                        {shortcut.note !== undefined && (
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {shortcut.note}
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
