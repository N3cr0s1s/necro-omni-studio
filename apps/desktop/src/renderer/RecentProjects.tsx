import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ChevronDownIcon, FolderOpenIcon } from 'lucide-react';
import { Button } from '@nos/ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@nos/ui/components/ui/dropdown-menu';
import type { RecentProject } from '../main/ipc-contract.js';
import { bridge } from './bridge.js';

/**
 * Opening a project, and the ones opened before.
 *
 * A project is a folder, so the only way in was the system's folder picker — every launch, and every
 * switch between two projects being cut in the same week, began by navigating a file dialog to a place
 * the application already knew. The shell has remembered the last one since the day it learned to
 * reopen; it simply never remembered more than one, and never showed what it had.
 *
 * A split control rather than a menu that swallows the picker. `Open project` stays exactly where it
 * was and does exactly what it did — the smoke check looks for it by that name, and more to the point
 * a user who has learned where it is should not have to learn again. The history is a second, quieter
 * affordance beside it.
 */

export interface RecentProjectsProps {
  /** Opens the folder picker. The list is a shortcut past it, never a replacement. */
  readonly onOpen: () => void;
  readonly onOpenPath: (root: string) => void;
  /**
   * Bumped by the caller when a project opens, so the list picks up the new order.
   *
   * A number rather than the project itself: this needs to know only that something changed, and
   * taking the project would make it re-read on every field of it that happens to differ.
   */
  readonly revision?: number;
}

export function RecentProjects({ onOpen, onOpenPath, revision = 0 }: RecentProjectsProps): ReactNode {
  const recent = useRecentProjects(revision);

  return (
    <div className="flex items-center">
      <Button variant="ghost" size="sm" onClick={onOpen} className="pr-2">
        <FolderOpenIcon />
        Open project
      </Button>

      {/*
        Hidden entirely with no history, rather than shown disabled. A disabled control says "there is
        something here you cannot have"; on a first run there is genuinely nothing, and an empty menu
        beside the picker would be furniture.
      */}
      {recent.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="px-1"
                aria-label="Recent projects"
                title="Projects opened before"
              >
                <ChevronDownIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-64">
            {recent.map((project) => (
              <DropdownMenuItem
                key={project.root}
                // A moved folder is offered and refused rather than dropped: a row vanishing on its
                // own is indistinguishable from the application having forgotten it, and the user is
                // left wondering which. The path is the title, because two projects can share a name.
                disabled={!project.available}
                title={project.available ? project.root : `${project.root} — not there any more`}
                onClick={() => onOpenPath(project.root)}
              >
                <span className="truncate">{project.name}</span>
                {!project.available && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">missing</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/**
 * Reads the list, and re-reads it when a project opens.
 *
 * Empty in a build with no bridge, which is the same answer as a first run — there is nothing to
 * reopen. Never throws: a history that cannot be read must not stop the picker from working, since
 * the picker is the thing that still gets you into a project.
 */
function useRecentProjects(revision: number): readonly RecentProject[] {
  const [recent, setRecent] = useState<readonly RecentProject[]>([]);

  const read = useCallback(() => {
    const api = bridge();
    if (api === undefined) return;

    let live = true;
    void Promise.resolve()
      .then(() => api.recentProjects())
      .then((projects) => {
        if (live) setRecent(projects);
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, []);

  useEffect(read, [read, revision]);

  return recent;
}
