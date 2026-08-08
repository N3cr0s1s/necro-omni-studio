import { type ReactNode, useState } from 'react';
import {
  type FrameRate,
  type TimelineDocument,
  FRAME_RATES,
  formatFrameRate,
  frameRateEquals,
} from '@nos/core';
import { applyProjectSettings, retimeCost } from '@nos/editing';
import { Button, Mono, SectionCaption } from '@nos/ui';
import { token } from '@nos/ui';

/**
 * The project's rate and resolution.
 *
 * Both have been in the document since M1 and neither could be changed after the project was
 * created — a decision most editors make *after* seeing their material, not before.
 *
 * The rate is applied through the editing layer, which rebases every time in the document. What this
 * component owns is the part that is a user-interface problem rather than a document one: saying
 * what the change will cost **before** it happens, since converting 30 → 24 and back does not
 * return the original frame positions.
 */

/** Resolutions worth a click. Anything else is typed in, which the fields below allow. */
const PRESETS: readonly { readonly label: string; readonly width: number; readonly height: number }[] = [
  { label: '1080p', width: 1920, height: 1080 },
  { label: '4K UHD', width: 3840, height: 2160 },
  { label: 'vertical', width: 1080, height: 1920 },
  { label: 'square', width: 1080, height: 1080 },
];

const RATES: readonly FrameRate[] = [
  FRAME_RATES.FILM_24,
  FRAME_RATES.NTSC_FILM_23_976,
  FRAME_RATES.PAL_25,
  FRAME_RATES.NTSC_29_97,
  FRAME_RATES.WEB_30,
  FRAME_RATES.PAL_HD_50,
  FRAME_RATES.WEB_60,
];

export interface ProjectSettingsProps {
  readonly document: TimelineDocument;
  readonly onChange: (label: string, next: TimelineDocument) => void;
  readonly onReject: (reason: string) => void;
}

/**
 * Describes what a rate change will move.
 *
 * Phrased as what the user will lose rather than as a count of internal objects: "12 of 40 positions
 * will shift by up to half a frame" is a sentence someone can act on, where "12 rounded" is not.
 */
export function describeRetime(cost: ReturnType<typeof retimeCost>): {
  readonly text: string;
  readonly lossy: boolean;
} {
  if (frameRateEquals(cost.from, cost.to)) return { text: 'same rate — nothing moves', lossy: false };
  if (cost.rounded === 0) {
    return { text: `${formatFrameRate(cost.to)} divides evenly — nothing shifts`, lossy: false };
  }
  return {
    text: `${cost.rounded} of ${cost.total} positions shift by up to half a frame`,
    lossy: true,
  };
}

export function ProjectSettings({ document, onChange, onReject }: ProjectSettingsProps): ReactNode {
  const [pendingRate, setPendingRate] = useState<FrameRate | undefined>(undefined);

  const apply = (rate: FrameRate, width: number, height: number, label: string): void => {
    const result = applyProjectSettings(document, {
      frameRate: rate,
      resolution: { width, height },
    });
    if (!result.ok) {
      onReject(`the project could not be changed: ${String(result.error.kind).replace(/-/g, ' ')}`);
      return;
    }
    onChange(label, result.value);
    setPendingRate(undefined);
  };

  const cost = pendingRate === undefined ? undefined : retimeCost(document, pendingRate);
  const described = cost === undefined ? undefined : describeRetime(cost);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
      <SectionCaption>Project</SectionCaption>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ font: token.textLabel, color: token.textSoft }}>size</span>
        <div style={{ flex: 1 }} />
        <Mono tone={token.textBright}>
          {document.resolution.width}×{document.resolution.height}
        </Mono>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            tone={
              preset.width === document.resolution.width && preset.height === document.resolution.height
                ? 'active'
                : 'default'
            }
            onClick={() => apply(document.frameRate, preset.width, preset.height, 'set resolution')}
            title={`${preset.width}×${preset.height}`}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ font: token.textLabel, color: token.textSoft }}>rate</span>
        <div style={{ flex: 1 }} />
        <Mono tone={token.textBright}>{formatFrameRate(document.frameRate)}</Mono>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {RATES.map((rate) => (
          <Button
            key={formatFrameRate(rate)}
            tone={frameRateEquals(rate, document.frameRate) ? 'active' : 'default'}
            // Armed rather than applied. A rate change rebases every time in the document and cannot
            // be undone without loss, so it gets the one confirmation step in this application.
            onClick={() => setPendingRate(frameRateEquals(rate, document.frameRate) ? undefined : rate)}
            title={`Change the project rate to ${formatFrameRate(rate)}`}
          >
            {formatFrameRate(rate)}
          </Button>
        ))}
      </div>

      {pendingRate !== undefined && described !== undefined && (
        <div
          role="alertdialog"
          aria-label="Confirm the frame rate change"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: 8,
            borderRadius: token.radiusControl,
            background: described.lossy ? 'rgba(255, 176, 32, 0.10)' : token.surface1,
          }}
        >
          <Mono tone={described.lossy ? token.warn : token.textDim}>{described.text}</Mono>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              tone="primary"
              onClick={() =>
                apply(pendingRate, document.resolution.width, document.resolution.height, 'set frame rate')
              }
            >
              Change to {formatFrameRate(pendingRate)}
            </Button>
            <Button onClick={() => setPendingRate(undefined)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
