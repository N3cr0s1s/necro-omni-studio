import { type ReactNode, useMemo, useState } from 'react';
import type { AssetPath } from '@nos/core';
import { UnplugIcon } from 'lucide-react';
import { relinkCandidates } from '@nos/editing';
import { Button } from '@nos/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nos/ui/components/ui/dialog';
import { Label } from '@nos/ui/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@nos/ui/components/ui/radio-group';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';

/**
 * Pointing a clip at media that has moved.
 *
 * The editor can say a file has left the folder; this is what a user does about it. Without it the
 * only repair was to close the editor, put the file back under its old name, and reopen — which is
 * not a repair, it is working around the absence of one.
 *
 * ## Suggested, then confirmed
 *
 * Files of the same name are offered first, because that is what survives the thing that actually
 * happens: a file moved into a subfolder, or a whole folder reorganised. It is a *guess*, though, and
 * a relink rewrites every clip reading that file — so the guess is offered and never applied. A
 * project with no name match still gets the full list rather than a dead end.
 */

export interface RelinkDialogProps {
  /** The path that no longer resolves. Absent closes the dialog. */
  readonly missing: AssetPath | undefined;
  /** Every file the project folder holds, for the case where no name matches. */
  readonly present: readonly AssetPath[];
  /** How many clips would follow the file, so the size of the change is stated before it happens. */
  readonly affected: number;
  readonly onRelink: (to: AssetPath) => void;
  readonly onClose: () => void;
}

export function RelinkDialog({
  missing,
  present,
  affected,
  onRelink,
  onClose,
}: RelinkDialogProps): ReactNode {
  const [chosen, setChosen] = useState<string | undefined>(undefined);

  const suggested = useMemo(
    () => (missing === undefined ? [] : relinkCandidates(missing, present)),
    [missing, present],
  );

  // The suggestions first and then everything else, rather than two lists: one column of paths is one
  // decision, and a user whose file was renamed needs the rest without changing mode.
  const offered = useMemo(() => {
    const rest = present.filter((path) => path !== missing && !suggested.includes(path));
    return [...suggested, ...rest];
  }, [present, missing, suggested]);

  const pick = chosen ?? suggested[0] ?? offered[0];

  return (
    <Dialog open={missing !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UnplugIcon className="size-4 text-destructive" />
            Relink media
          </DialogTitle>
          <DialogDescription>
            {/* The path and the blast radius, before anything is chosen: a relink follows the file
                everywhere it is used, and that is worth knowing in advance rather than discovering. */}
            {`${missing ?? ''} is missing. Choosing a file repoints ${affected} clip${
              affected === 1 ? '' : 's'
            }.`}
          </DialogDescription>
        </DialogHeader>

        {offered.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">
            this project has no other file to point at — put the file back, or import it
          </p>
        ) : (
          <ScrollArea className="max-h-72 pr-3">
            <RadioGroup
              aria-label="Replacement file"
              value={pick ?? ''}
              onValueChange={(next) => typeof next === 'string' && setChosen(next)}
              className="flex flex-col gap-1"
            >
              {offered.map((path) => (
                <Label
                  key={path}
                  className="flex items-center gap-2 rounded-md px-1 py-1 font-mono text-xs font-normal"
                >
                  <RadioGroupItem value={path} />
                  <span className="truncate">{path}</span>
                  {suggested.includes(path) && (
                    // Marked rather than sorted silently: the user should be able to tell a guess from
                    // the rest of the folder.
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">same name</span>
                  )}
                </Label>
              ))}
            </RadioGroup>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={pick === undefined}
            onClick={() => {
              if (pick !== undefined) onRelink(pick as AssetPath);
            }}
          >
            Relink
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
