import { type ReactNode, useEffect, useState } from 'react';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  DownloadIcon,
  FilmIcon,
  InfoIcon,
  ScanIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UploadIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@nos/ui/components/ui/popover';
import { Progress } from '@nos/ui/components/ui/progress';
import { ScrollArea } from '@nos/ui/components/ui/scroll-area';
import { Separator } from '@nos/ui/components/ui/separator';
import { Spinner } from '@nos/ui/components/ui/spinner';
import { cn } from '@nos/ui/lib/utils';
import {
  type Activity,
  type ActivityKind,
  type StatusNotice,
  formatElapsed,
  formatProgress,
  isRunning,
  summarizeActivities,
} from './activity.js';

/**
 * The bar along the bottom: what is happening, how far along, and anything the application needs to
 * say.
 *
 * One place at the foot of the window rather than three scattered ones. Before this a running job was
 * a bare count in the title bar — `3 jobs`, with no way to see *which* three — an export's progress
 * lived inside its own dialog, a derivation reported nothing at all, and messages appeared as a banner
 * at the top that pushed the whole editor down as it came and went.
 *
 * Everything it shows arrives as `Activity` or `StatusNotice`, so a new kind of background work needs
 * a mapping function and no change here.
 */

export interface StatusBarProps {
  readonly activities: readonly Activity[];
  /** Messages, and the decisions some of them carry. */
  readonly notices?: readonly StatusNotice[];
  /** Trailing content — the frame rate, the clip count, whatever the shell wants on the right. */
  readonly children?: ReactNode;
}

const KIND_ICON: Readonly<Record<ActivityKind, LucideIcon>> = {
  generate: SparklesIcon,
  export: UploadIcon,
  derive: FilmIcon,
  segment: ScanIcon,
  import: DownloadIcon,
};

export function StatusBar({ activities, notices = [], children }: StatusBarProps): ReactNode {
  const summary = summarizeActivities(activities);
  const percent = formatProgress(summary.progress);
  const busy = summary.runningCount > 0;

  return (
    <footer aria-label="Status" className="flex flex-none flex-col border-t">
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} />
      ))}

      <div className="flex h-7 items-center gap-2 px-3 text-xs">
        {busy ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : summary.failure !== undefined ? (
          <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CircleCheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}

        <span
          className={cn('truncate font-mono', summary.failure !== undefined && !busy && 'text-destructive')}
        >
          {summary.headline}
        </span>
        {summary.detail !== undefined && (
          <span className="truncate font-mono text-muted-foreground">{summary.detail}</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {children}

          {activities.length > 0 && <ActivityList activities={activities} />}

          {/* The bar itself, on the right as the request asks. Kept mounted while anything runs even
              with nothing measurable yet, so the space does not appear and disappear under the
              pointer as a job moves from accepted to reporting. */}
          {busy && (
            <div className="flex w-40 items-center gap-2">
              <Progress
                aria-label="Overall progress"
                value={(summary.progress ?? 0) * 100}
                className={cn('block flex-1', summary.progress === undefined && 'opacity-40')}
              />
              <span className="w-8 shrink-0 text-right font-mono text-muted-foreground tabular-nums">
                {percent ?? '—'}
              </span>
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}

/**
 * A message, and the decision it may carry.
 *
 * At the bottom with everything else. As a banner at the top it moved the entire editor down when it
 * appeared and back up when it went — so the timeline a user was pointing at shifted under the
 * pointer, which is the one thing a message must not do.
 */
function Notice({ notice }: { readonly notice: StatusNotice }): ReactNode {
  const Icon =
    notice.tone === 'error' ? CircleAlertIcon : notice.tone === 'warning' ? TriangleAlertIcon : InfoIcon;

  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-center gap-2 border-t px-3 py-1.5 font-mono text-xs first:border-t-0',
        notice.tone === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{notice.message}</span>
      {notice.actions !== undefined && notice.actions.length > 0 && (
        <div className="ml-auto flex shrink-0 gap-1.5">
          {notice.actions.map((action) => (
            <Button
              key={action.label}
              size="xs"
              variant={action.primary === true ? 'default' : 'ghost'}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Every task, opened from the count.
 *
 * The count alone was the whole of what the application said about generation: `3 jobs`, and no way to
 * learn which three, how far along any of them was, or what any of them was asked to make. A run takes
 * minutes, so that is exactly the period during which a user wants to know.
 */
function ActivityList({ activities }: { readonly activities: readonly Activity[] }): ReactNode {
  const running = activities.filter(isRunning);
  // A clock of its own, so elapsed times count up. Owned here rather than in the shell, where it would
  // re-render the timeline and the preview once a second to update a few characters.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (running.length === 0) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [running.length]);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="xs" title="Show every task" className="font-mono">
            {running.length > 0
              ? `${running.length} running`
              : `${activities.length} ${activities.length === 1 ? 'task' : 'tasks'}`}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-96 p-0">
        <div className="px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Tasks
        </div>
        <Separator />
        <ScrollArea className="max-h-96">
          <div className="flex flex-col">
            {activities.map((activity) => (
              <ActivityRow key={activity.id} activity={activity} now={now} />
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function ActivityRow({ activity, now }: { readonly activity: Activity; readonly now: number }): ReactNode {
  const Icon = KIND_ICON[activity.kind];
  const percent = formatProgress(activity.progress);
  const elapsed = formatElapsed(activity, now);

  return (
    <div className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2 text-xs">
        <Icon
          className={cn(
            'size-3.5 shrink-0',
            activity.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        />
        <span className="truncate font-medium">{activity.label}</span>
        <span className="ml-auto shrink-0 font-mono text-muted-foreground tabular-nums">
          {activity.state === 'running' ? (percent ?? elapsed ?? '…') : <StateBadge state={activity.state} />}
        </span>
      </div>

      {activity.state === 'running' && activity.progress !== undefined && (
        <Progress
          aria-label={`${activity.label} progress`}
          value={activity.progress * 100}
          className="block"
        />
      )}

      {activity.detail !== undefined && (
        <p
          className={cn(
            'truncate font-mono text-xs',
            activity.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {activity.detail}
        </p>
      )}

      {/* What it was asked to make. A finished run is only recognisable by its parameters — the id is
          a hash, and three variants of one prompt are otherwise indistinguishable. */}
      {activity.facts !== undefined && activity.facts.length > 0 && (
        <dl className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground">
          {activity.facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 gap-1">
              <dt className="shrink-0 opacity-60">{fact.label}</dt>
              <dd className="truncate">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function StateBadge({ state }: { readonly state: Activity['state'] }): ReactNode {
  if (state === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1">
        <CircleAlertIcon />
        failed
      </Badge>
    );
  }
  if (state === 'cancelled') {
    return (
      <Badge variant="outline" className="gap-1">
        <CircleSlashIcon />
        cancelled
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 text-chart-2">
      <CircleCheckIcon />
      done
    </Badge>
  );
}
