import { type ReactNode, useMemo } from 'react';
import { CircleCheckIcon, FolderOpenIcon, GaugeIcon, TriangleAlertIcon, UploadIcon } from 'lucide-react';
import type { ValidationIssue } from '@nos/core';
import { baseName, uniquePath } from '@nos/media';
import {
  type EncoderSpeed,
  type ExportProgress,
  type ExportSettings,
  type QualityPreset,
  type VideoCodec,
  ENCODER_SPEEDS,
  QUALITY_PRESETS,
  VIDEO_CODECS,
  describeSettings,
  estimateSizeBytes,
  exportDurationSeconds,
  formatEstimate,
  formatRemaining,
  reviewResolution,
  validateExportSettings,
} from '@nos/export';
import { Badge } from '@nos/ui/components/ui/badge';
import { Switch } from '@nos/ui/components/ui/switch';
import { Button } from '@nos/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nos/ui/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@nos/ui/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@nos/ui/components/ui/input-group';
import { Progress } from '@nos/ui/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@nos/ui/components/ui/toggle-group';
import { cn } from '@nos/ui/lib/utils';

/**
 * The export dialog.
 *
 * Presents the settings the spec's scope allows — H.264/H.265 into mp4 — and nothing more. Offering a
 * codec or container the pipeline does not implement would imply capability that is not there.
 *
 * Validation runs continuously rather than on submit, so a problem is visible next to the field that
 * caused it while the user is still looking at it. Export is a long operation; discovering a bad output
 * path after committing to it is a poor trade.
 *
 * The modal behaviour — backdrop, focus trap, Escape, returning focus to whatever opened it — is the
 * registry's. It used to be a `div` with `aria-modal` on it, which claimed all of that and provided
 * none of it.
 */

export interface ExportDialogProps {
  readonly settings: ExportSettings;
  /**
   * Defaults to open, because the caller mounts this only when it wants it shown. Present so a caller
   * that would rather keep it mounted can close it and get the exit animation.
   */
  readonly open?: boolean;
  /** Present while an export is running. Absent means the form is editable. */
  readonly progress?: ExportProgress;
  readonly onChange?: (settings: ExportSettings) => void;
  readonly onStart?: () => void;
  readonly onCancel?: () => void;
  readonly onClose?: () => void;
  /** Opens a file picker for the destination. */
  readonly onBrowse?: () => void;
  /** Shows the finished file in the file manager. Offered only once there is one. */
  readonly onReveal?: () => void;
  /**
   * Project-relative paths that already exist, so a delivery about to replace one can say so.
   *
   * The encoder overwrites — it passes `-y`, which is right for a deliberate re-render — and the
   * dialog offers the same `renders/<project>.mp4` every time it opens. Between the two, a second
   * export silently destroyed the first: minutes of GPU time and, often, the only copy of a finished
   * cut. Everything else in this application refuses to destroy without a word, and this was the one
   * place where losing something cost the most.
   *
   * Optional, because a caller that has not read the folder should not be forced to claim the file is
   * absent. Absent means "not known", and nothing is said.
   */
  readonly existingFiles?: ReadonlySet<string>;
}

export function ExportDialog({
  settings,
  open = true,
  progress,
  onChange,
  onStart,
  onCancel,
  onClose,
  onReveal,
  onBrowse,
  existingFiles,
}: ExportDialogProps): ReactNode {
  const validation = useMemo(() => validateExportSettings(settings), [settings]);
  const issues: readonly ValidationIssue[] = validation.ok ? [] : validation.error;
  const durationSeconds = exportDurationSeconds(settings);
  const estimate = estimateSizeBytes(settings, durationSeconds);

  const running =
    progress !== undefined &&
    progress.phase !== 'complete' &&
    progress.phase !== 'cancelled' &&
    progress.phase !== 'failed';

  const update = (patch: Partial<ExportSettings>): void => onChange?.({ ...settings, ...patch });
  const issueFor = (path: string): string | undefined => issues.find((issue) => issue.path === path)?.message;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A running export is not abandoned by a stray Escape: cancelling is a decision, and the
        // Cancel button is where it is made.
        if (!next && !running) onClose?.();
      }}
    >
      <DialogContent aria-label="Export" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadIcon className="size-4" />
            Export
          </DialogTitle>
          <DialogDescription className="font-mono">{describeSettings(settings)}</DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="export-path" className="w-18 shrink-0">
              Save to
            </FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="export-path"
                readOnly
                value={settings.outputPath}
                placeholder="not set"
                aria-invalid={issueFor('outputPath') !== undefined}
                // The tail of a path is the informative part; a truncated head hides the filename, so
                // the overflow is pushed to the left.
                dir="rtl"
                className="text-left"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={onBrowse} disabled={running}>
                  <FolderOpenIcon />
                  Browse
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
          <FieldIssue message={issueFor('outputPath')} />
          <Overwrite
            path={settings.outputPath}
            {...(existingFiles !== undefined ? { existingFiles } : {})}
            disabled={running}
            onUse={(path) => onChange?.({ ...settings, outputPath: path })}
          />

          <Field orientation="horizontal">
            <FieldLabel className="w-18 shrink-0">Codec</FieldLabel>
            <Choice
              options={VIDEO_CODECS}
              value={settings.videoCodec}
              disabled={running}
              label={(codec: VideoCodec) => (codec === 'h264' ? 'H.264' : 'H.265')}
              onSelect={(videoCodec) => update({ videoCodec })}
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel className="w-18 shrink-0">Quality</FieldLabel>
            <Choice
              options={QUALITY_PRESETS}
              value={settings.quality}
              disabled={running}
              label={(quality: QualityPreset) => quality}
              onSelect={(quality) => update({ quality })}
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel className="w-18 shrink-0">Speed</FieldLabel>
            <Choice
              options={ENCODER_SPEEDS}
              value={settings.speed}
              disabled={running}
              label={(speed: EncoderSpeed) => speed}
              onSelect={(speed) => update({ speed })}
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel className="w-18 shrink-0" htmlFor="export-review">
              Review copy
            </FieldLabel>
            {/*
             * A switch, and never on by default. The badge below has warned about this setting since
             * it was declared, but nothing could turn it on — so the one deliverable it exists for, a
             * fast copy for someone to comment on, could not be produced at all.
             */}
            <Switch
              id="export-review"
              aria-label="Review copy"
              disabled={running}
              checked={settings.useProxyResolution}
              onCheckedChange={(useProxyResolution: boolean) => update({ useProxyResolution })}
            />
            <span className="font-mono text-xs text-muted-foreground">
              {settings.useProxyResolution
                ? `${reviewResolution(settings.resolution).width}×${reviewResolution(settings.resolution).height}`
                : 'full resolution'}
            </span>
          </Field>

          <Field orientation="horizontal">
            <FieldLabel className="w-18 shrink-0">Range</FieldLabel>
            <span className="font-mono text-sm">
              {settings.range.duration} f · {durationSeconds.toFixed(1)} s
            </span>
          </Field>
          <FieldIssue message={issueFor('range')} />
          <FieldIssue message={issueFor('resolution')} />
        </FieldGroup>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <GaugeIcon className="size-3.5" />
          <span className="font-mono">about {formatEstimate(estimate)}</span>
          {settings.useProxyResolution && (
            <Badge variant="destructive" className="ml-auto">
              <TriangleAlertIcon />
              proxy resolution
            </Badge>
          )}
        </div>

        {progress !== undefined && (
          <ProgressSection
            progress={progress}
            outputPath={settings.outputPath}
            {...(onReveal !== undefined ? { onReveal } : {})}
          />
        )}

        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button
                onClick={onStart}
                disabled={!validation.ok}
                title={validation.ok ? undefined : 'Fix the highlighted settings first'}
              >
                <UploadIcon />
                Export
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A validation message under its field.
 *
 * Rendered inline rather than collected into a summary at the bottom: an error next to the control that
 * caused it needs no hunting, and export has enough fields that a summary would.
 */
function FieldIssue({ message }: { readonly message: string | undefined }): ReactNode {
  if (message === undefined) return null;
  return <FieldError className="-mt-2 pl-19">{message}</FieldError>;
}

/**
 * A segmented choice.
 *
 * A toggle group rather than a `<select>`: the option sets are small and fixed, and showing them all
 * lets the user compare rather than remember. The pressed state carries the answer, so it is not
 * conveyed by tint alone.
 */
function Choice<T extends string>({
  options,
  value,
  disabled,
  label,
  onSelect,
}: {
  readonly options: readonly T[];
  readonly value: T;
  readonly disabled: boolean;
  readonly label: (option: T) => string;
  readonly onSelect: (option: T) => void;
}): ReactNode {
  return (
    <ToggleGroup
      value={[value]}
      disabled={disabled}
      onValueChange={(next) => {
        // Base UI reports the whole set. Taking the last entry keeps this single-select without
        // letting a click on the current option deselect it — there is no "no codec".
        const chosen = next.at(-1) as T | undefined;
        if (chosen !== undefined) onSelect(chosen);
      }}
      className="flex-1"
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option} className="flex-1 capitalize">
          {label(option)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Progress bar, rate and remaining estimate. */
function ProgressSection({
  progress,
  outputPath,
  onReveal,
}: {
  readonly progress: ExportProgress;
  readonly outputPath?: string;
  readonly onReveal?: () => void;
}): ReactNode {
  const failed = progress.phase === 'failed';
  const done = progress.phase === 'complete';

  return (
    <div className="flex flex-col gap-3">
      <Progress
        aria-label="Export progress"
        value={Math.round(progress.fraction * 100)}
        className={cn(
          'block',
          failed && '[&_[data-slot=progress-indicator]]:bg-destructive',
          done && '[&_[data-slot=progress-indicator]]:bg-chart-2',
        )}
      />

      <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
        <span className={cn(failed && 'text-destructive')}>
          {progress.framesDone} / {progress.framesTotal} f
        </span>
        <span>{progress.fps} fps</span>
        <span className="ml-auto flex items-center gap-1.5">
          {done && <CircleCheckIcon className="size-3.5" />}
          {failed && <TriangleAlertIcon className="size-3.5 text-destructive" />}
          {done
            ? 'complete'
            : failed
              ? (progress.message ?? 'failed')
              : formatRemaining(progress.remainingSeconds)}
        </span>
      </div>

      {progress.message !== undefined && !failed && (
        <p className="font-mono text-xs text-muted-foreground">{progress.message}</p>
      )}

      {done && onReveal !== undefined && (
        // A way to get to the file. After a render that took minutes, "show me the file" is the next
        // thing anyone wants — and the destination is already named in the field above, so this adds
        // the action rather than repeating the path.
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={onReveal}
            title={`Show ${outputPath ?? 'the finished file'} in the file manager`}
          >
            <FolderOpenIcon />
            Reveal
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * What is already at the destination, and the way past it.
 *
 * A warning rather than a refusal: re-rendering over a previous take is an ordinary thing to want, and
 * an export that could not overwrite would be one people work around by hand. What was missing is the
 * *word* — so this says what will happen and offers a free name in one click, which is the same shape
 * as every other destructive action here.
 *
 * Drawn as a warning and not as muted status, for the reason the backend line is: this is a
 * consequence, not a fact about the form.
 */
function Overwrite({
  path,
  existingFiles,
  disabled,
  onUse,
}: {
  readonly path: string;
  readonly existingFiles?: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onUse: (path: string) => void;
}): ReactNode {
  // Nothing known about the folder, or nothing there: either way there is nothing to warn about.
  if (existingFiles === undefined || !existingFiles.has(path)) return null;

  const free = uniquePath(path, existingFiles);

  return (
    <p className="text-destructive flex items-center gap-2 pl-20 font-mono text-xs">
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{`${path} exists and will be replaced`}</span>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => onUse(free)}>
        {`Save as ${baseName(free)}`}
      </Button>
    </p>
  );
}
