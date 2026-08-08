import { type ReactNode, useMemo } from 'react';
import type { ValidationIssue } from '@nos/core';
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
  validateExportSettings,
} from '@nos/export';
import { Badge, Button, FieldRow, Mono, SectionCaption, ValueField } from '../primitives/Primitives.js';
import { token } from '../tokens/tokens.js';

/**
 * The export dialog.
 *
 * Presents the settings the spec's scope allows — H.264/H.265 into mp4 — and nothing more. Offering a
 * codec or container the pipeline does not implement would imply capability that is not there.
 *
 * Validation runs continuously rather than on submit, so a problem is visible next to the field that
 * caused it while the user is still looking at it. Export is a long operation; discovering a bad output
 * path after committing to it is a poor trade.
 */

export interface ExportDialogProps {
  readonly settings: ExportSettings;
  /** Present while an export is running. Absent means the form is editable. */
  readonly progress?: ExportProgress;
  readonly onChange?: (settings: ExportSettings) => void;
  readonly onStart?: () => void;
  readonly onCancel?: () => void;
  readonly onClose?: () => void;
  /** Opens a file picker for the destination. */
  readonly onBrowse?: () => void;
}

export function ExportDialog({
  settings,
  progress,
  onChange,
  onStart,
  onCancel,
  onClose,
  onBrowse,
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Export"
      style={{
        width: 460,
        background: token.bgPanel,
        border: `1px solid ${token.border}`,
        borderRadius: token.radiusPanel,
        padding: token.space7,
        display: 'flex',
        flexDirection: 'column',
        gap: token.space6,
        color: token.textPrimary,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: token.space3 }}>
        <SectionCaption>Export</SectionCaption>
        <div style={{ flex: 1 }} />
        <Mono tone={token.textFaint}>{describeSettings(settings)}</Mono>
      </div>

      <FieldRow label="Save to">
        <ValueField style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              // The tail of a path is the informative part; a truncated head hides the filename.
              direction: 'rtl',
              textAlign: 'left',
            }}
          >
            {settings.outputPath || 'not set'}
          </span>
        </ValueField>
        <Button onClick={onBrowse} disabled={running}>
          Browse
        </Button>
      </FieldRow>
      <FieldIssue message={issueFor('outputPath')} />

      <FieldRow label="Codec">
        <Choice
          options={VIDEO_CODECS}
          value={settings.videoCodec}
          disabled={running}
          label={(codec: VideoCodec) => (codec === 'h264' ? 'H.264' : 'H.265')}
          onSelect={(videoCodec) => update({ videoCodec })}
        />
      </FieldRow>

      <FieldRow label="Quality">
        <Choice
          options={QUALITY_PRESETS}
          value={settings.quality}
          disabled={running}
          label={(quality: QualityPreset) => quality}
          onSelect={(quality) => update({ quality })}
        />
      </FieldRow>

      <FieldRow label="Speed">
        <Choice
          options={ENCODER_SPEEDS}
          value={settings.speed}
          disabled={running}
          label={(speed: EncoderSpeed) => speed}
          onSelect={(speed) => update({ speed })}
        />
      </FieldRow>

      <FieldRow label="Range">
        <ValueField style={{ flex: 1 }}>
          {settings.range.duration} f · {durationSeconds.toFixed(1)} s
        </ValueField>
      </FieldRow>
      <FieldIssue message={issueFor('range')} />
      <FieldIssue message={issueFor('resolution')} />

      <div style={{ display: 'flex', alignItems: 'center', gap: token.space3 }}>
        <Mono tone={token.textDim}>about {formatEstimate(estimate)}</Mono>
        <div style={{ flex: 1 }} />
        {settings.useProxyResolution && <Badge tone="warn">proxy resolution</Badge>}
      </div>

      {progress !== undefined && <ProgressSection progress={progress} />}

      <div style={{ display: 'flex', gap: token.space3, justifyContent: 'flex-end' }}>
        {running ? (
          <Button onClick={onCancel}>Cancel</Button>
        ) : (
          <>
            <Button onClick={onClose}>Close</Button>
            <Button
              tone="primary"
              onClick={onStart}
              disabled={!validation.ok}
              title={validation.ok ? undefined : 'Fix the highlighted settings first'}
            >
              Export
            </Button>
          </>
        )}
      </div>
    </div>
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
  return (
    <div style={{ paddingLeft: 76, marginTop: -8 }}>
      <Mono tone={token.danger}>{message}</Mono>
    </div>
  );
}

/**
 * A segmented choice.
 *
 * A radio group rather than a `<select>`: the option sets are small and fixed, and showing them all lets
 * the user compare rather than remember. `aria-checked` carries the state, so it is not conveyed by tint
 * alone.
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
    <div role="radiogroup" style={{ display: 'flex', gap: token.space1, flex: 1 }}>
      {options.map((option) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(option)}
            style={{
              flex: 1,
              height: token.controlHeight,
              borderRadius: token.radiusControl,
              background: selected ? '#1c2333' : token.surface2,
              border: `1px solid ${selected ? '#2f4a72' : token.borderControl}`,
              color: selected ? '#9dc2ff' : token.textMuted,
              font: `500 11px ${token.fontUi}`,
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              textTransform: 'capitalize',
            }}
          >
            {label(option)}
          </button>
        );
      })}
    </div>
  );
}

/** Progress bar, rate and remaining estimate. */
function ProgressSection({ progress }: { readonly progress: ExportProgress }): ReactNode {
  const failed = progress.phase === 'failed';
  const done = progress.phase === 'complete';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space3 }}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.fraction * 100)}
        aria-label="Export progress"
        style={{
          height: 5,
          borderRadius: 2,
          background: token.surface2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress.fraction * 100}%`,
            height: '100%',
            background: failed ? token.danger : done ? token.ok : token.accent,
            // The only place a transition is welcome in this app's motion budget: a progress bar that
            // jumps per frame reads as jitter, and it never moves under the pointer.
            transition: `width ${token.transition}`,
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: token.space3 }}>
        <Mono tone={failed ? token.danger : token.textDim}>
          {progress.framesDone} / {progress.framesTotal} f
        </Mono>
        <Mono tone={token.textFaint}>{progress.fps} fps</Mono>
        <div style={{ flex: 1 }} />
        <Mono tone={token.textFaint}>
          {done
            ? 'complete'
            : failed
              ? (progress.message ?? 'failed')
              : formatRemaining(progress.remainingSeconds)}
        </Mono>
      </div>

      {progress.message !== undefined && !failed && <Mono tone={token.textGhost}>{progress.message}</Mono>}
    </div>
  );
}
