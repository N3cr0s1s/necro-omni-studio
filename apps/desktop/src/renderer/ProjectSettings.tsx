import { type ReactNode, useState } from 'react';
import {
  type FrameRate,
  type TimelineDocument,
  FRAME_RATES,
  formatFrameRate,
  frameRateEquals,
} from '@nos/core';
import { applyProjectSettings, retimeCost } from '@nos/editing';
import { SlidersHorizontalIcon, MonitorIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@nos/ui/components/ui/alert';
import { Button } from '@nos/ui/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@nos/ui/components/ui/toggle-group';
import { Field, FieldLabel } from '@nos/ui/components/ui/field';
import { Input } from '@nos/ui/components/ui/input';
import { Separator } from '@nos/ui/components/ui/separator';
import { NumberField } from '@nos/ui';
import { type AppSettings, VARIANT_MAXIMUM_RANGE } from '../main/app-settings.js';

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
  /**
   * Settings that apply to every project on this machine. Absent until the first read lands, which
   * leaves the section out rather than showing a value that may be about to change under the user.
   */
  readonly appSettings?: AppSettings | undefined;
  readonly onChangeAppSettings?: ((patch: Partial<AppSettings>) => void) | undefined;
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

/**
 * Which preset the current resolution *is*, or the empty string when it is none of them.
 *
 * A toggle group needs a value, and "1920×1080 typed in by hand" and "the 1080p preset" are the same
 * project. Anything unrecognised leaves every button unpressed rather than lighting the nearest one.
 */
function currentPreset(resolution: { readonly width: number; readonly height: number }): string {
  return (
    PRESETS.find((preset) => preset.width === resolution.width && preset.height === resolution.height)
      ?.label ?? ''
  );
}

export function ProjectSettings({
  document,
  onChange,
  onReject,
  appSettings,
  onChangeAppSettings,
}: ProjectSettingsProps): ReactNode {
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
    <div className="flex flex-col gap-2.5 p-3">
      <div className="flex items-center gap-2">
        <MonitorIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Project</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">size</span>
        <span className="ml-auto font-mono text-xs">
          {document.resolution.width}×{document.resolution.height}
        </span>
      </div>

      <ToggleGroup
        aria-label="Resolution"
        value={[currentPreset(document.resolution)]}
        onValueChange={(next) => {
          const chosen = PRESETS.find((preset) => preset.label === next.at(-1));
          if (chosen !== undefined) apply(document.frameRate, chosen.width, chosen.height, 'set resolution');
        }}
        className="flex-wrap justify-start"
      >
        {PRESETS.map((preset) => (
          <ToggleGroupItem key={preset.label} value={preset.label} title={`${preset.width}×${preset.height}`}>
            {preset.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">rate</span>
        <span className="ml-auto font-mono text-xs">{formatFrameRate(document.frameRate)}</span>
      </div>

      <ToggleGroup
        aria-label="Frame rate"
        value={[formatFrameRate(document.frameRate)]}
        // Armed rather than applied. A rate change rebases every time in the document and cannot be
        // undone without loss, so it gets the one confirmation step in this application.
        onValueChange={(next) => {
          const chosen = RATES.find((rate) => formatFrameRate(rate) === next.at(-1));
          setPendingRate(
            chosen !== undefined && !frameRateEquals(chosen, document.frameRate) ? chosen : undefined,
          );
        }}
        className="flex-wrap justify-start"
      >
        {RATES.map((rate) => (
          <ToggleGroupItem
            key={formatFrameRate(rate)}
            value={formatFrameRate(rate)}
            title={`Change the project rate to ${formatFrameRate(rate)}`}
          >
            {formatFrameRate(rate)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {pendingRate !== undefined && described !== undefined && (
        <Alert
          role="alertdialog"
          aria-label="Confirm the frame rate change"
          variant={described.lossy ? 'destructive' : 'default'}
        >
          {described.lossy && <TriangleAlertIcon />}
          <AlertTitle>Change to {formatFrameRate(pendingRate)}?</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span className="font-mono text-xs">{described.text}</span>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  apply(pendingRate, document.resolution.width, document.resolution.height, 'set frame rate')
                }
              >
                Change to {formatFrameRate(pendingRate)}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPendingRate(undefined)}>
                Cancel
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/*
       * Application settings, kept visibly apart from the project's.
       *
       * §5.8 asks for a global override of the variant count, and a cap on how much work a machine
       * takes on follows the machine rather than the cut — so it is stored beside the session file and
       * labelled here as applying to every project, rather than sitting silently among settings that
       * do not.
       */}
      {appSettings !== undefined && (
        <>
          <Separator />
          <div className="flex items-center gap-2">
            <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Application
            </span>
          </div>

          <Field orientation="horizontal">
            {/* The field carries the name itself; a second label pointing at it would read the name
                twice to a screen reader. */}
            <FieldLabel className="text-xs">Variants per run, at most</FieldLabel>
            <NumberField
              aria-label="Variants per run, at most"
              value={appSettings.variantMaximum}
              min={VARIANT_MAXIMUM_RANGE.min}
              max={VARIANT_MAXIMUM_RANGE.max}
              step={1}
              onCommit={(next) => onChangeAppSettings?.({ variantMaximum: Math.round(next) })}
              className="ml-auto w-16 font-mono tabular-nums"
            />
          </Field>
          <p className="font-mono text-xs text-muted-foreground">
            a ceiling for every project on this machine — a manifest still decides how many it wants
          </p>

          <Field orientation="horizontal">
            <FieldLabel className="text-xs" htmlFor="backend-url">
              Backend
            </FieldLabel>
            <Input
              id="backend-url"
              aria-label="Backend address"
              placeholder="http://127.0.0.1:8188"
              defaultValue={appSettings.backendUrl}
              // On blur rather than per keystroke: `http://1` is a valid address and would be stored,
              // and every later character would be a new one — pointing the backend at a different
              // machine on the way to typing the right one.
              onBlur={(event) => onChangeAppSettings?.({ backendUrl: event.target.value })}
              className="ml-auto w-52 font-mono text-xs"
            />
          </Field>
          <p className="font-mono text-xs text-muted-foreground">
            where ComfyUI is — leave it empty for the local default
          </p>
        </>
      )}
    </div>
  );
}
