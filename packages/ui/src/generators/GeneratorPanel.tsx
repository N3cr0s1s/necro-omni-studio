import { type ReactNode, useMemo } from 'react';
import type { PresetId } from '@nos/core';
import {
  type AssetChoice,
  type GeneratorManifest,
  type GeneratorParam,
  type RegistryRecord,
  choicesFor,
  defaultFor,
  describeBlockers,
  describeConstraint,
  describeRecord,
  effectiveDefaults,
  isAssetParam,
  planVariants,
  runBlockers,
  supportsVariants,
  visibleParams,
} from '@nos/generators';
import {
  ArrowRightIcon,
  CameraIcon,
  CircleAlertIcon,
  LockIcon,
  LockOpenIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Badge } from '@nos/ui/components/ui/badge';
import { Button } from '@nos/ui/components/ui/button';
import { Field, FieldLabel } from '@nos/ui/components/ui/field';
import { Input } from '@nos/ui/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@nos/ui/components/ui/native-select';
import { Slider } from '@nos/ui/components/ui/slider';
import { Switch } from '@nos/ui/components/ui/switch';
import { Textarea } from '@nos/ui/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@nos/ui/components/ui/toggle-group';
import { cn } from '@nos/ui/lib/utils';

/**
 * The generator parameter panel.
 *
 * Generated **entirely from the manifest**, as mockup 1c shows and the spec requires: consumes/produces
 * badges, presets, declared parameters with their ranges, declared-versus-discovered length, and a variant
 * count tied to whether a seed parameter exists. There is no per-generator code anywhere — a new generator
 * is a JSON file and this panel renders it.
 *
 * The consequence worth stating: nothing here may branch on a generator id. Any such branch would be the
 * first crack in the property that makes the whole framework worth having.
 */

export interface GeneratorPanelProps {
  readonly record: RegistryRecord;
  readonly preset?: PresetId;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly variantCount?: number;
  readonly lockedSeed?: number;
  /** Live enum options from the backend, keyed `nodeClass/input`. */
  readonly capabilityOptions?: ReadonlyMap<string, readonly string[]>;
  /**
   * Files offerable for asset-valued parameters — a first frame, a voice reference, a mask.
   *
   * The panel filters this by each parameter's declared type; the caller supplies the whole set and
   * decides what a project's files are called, because reading a folder is not this component's job.
   */
  readonly assetChoices?: readonly AssetChoice[];
  /**
   * Capturing the frame under the playhead for an image-valued parameter.
   *
   * Offered alongside the project's files rather than instead of them: a first frame is very often
   * a moment already in the cut, and asking the user to export a still, find it, and come back is
   * the kind of round trip that makes a tool feel like several tools.
   */
  readonly frameGrab?: FrameGrabOffer;
  /**
   * The project's shape, for parameters whose sensible default depends on it.
   *
   * A generator defaulting to a square output in a 16:9 sequence is pillarboxed the moment it lands
   * on the timeline — which is what "it generates badly" turns out to mean. The manifest cannot know
   * the sequence, so it declares what to derive from and this supplies the project.
   */
  readonly projectShape?: { readonly width: number; readonly height: number };

  readonly onChangeParam?: (key: string, value: string | number | boolean) => void;
  readonly onChangePreset?: (preset: PresetId | undefined) => void;
  readonly onChangeVariantCount?: (count: number) => void;
  readonly onToggleSeedLock?: () => void;
  readonly onRun?: () => void;
}

/**
 * What grabbing the current frame would do, as the caller sees it.
 *
 * `describe` is `undefined` when there is nothing under the playhead — the button is then shown
 * disabled saying so, rather than hidden, because a control that appears and disappears as the
 * playhead moves is harder to learn than one that explains itself.
 */
export interface FrameGrabOffer {
  /** What would be captured, e.g. `frame 137 of take.mp4`. `undefined` when nothing is. */
  readonly describe: string | undefined;
  /** True while the frame is being written, so the button can say so instead of looking dead. */
  readonly busy?: boolean;
  grab(paramKey: string): void;
}

export function GeneratorPanel({
  record,
  preset,
  params,
  variantCount,
  lockedSeed,
  capabilityOptions,
  assetChoices,
  frameGrab,
  projectShape,
  onChangeParam,
  onChangePreset,
  onChangeVariantCount,
  onToggleSeedLock,
  onRun,
}: GeneratorPanelProps): ReactNode {
  const manifest = record.manifest;
  const runnable = record.status === 'available';
  const shown = useMemo(() => visibleParams(manifest, preset), [manifest, preset]);
  const defaults = useMemo(() => effectiveDefaults(manifest, preset), [manifest, preset]);

  // The plan drives the variant control, so the panel and the queue cannot disagree about how many runs a
  // click will produce.
  // Derived defaults resolve against the project and the options the backend actually offers, and
  // beat the manifest's literal when they resolve — they were chosen knowing the sequence and it
  // was not. A value the user has set beats both, which is what makes this a default and not a rule.
  const derived = useMemo(() => {
    if (projectShape === undefined) return {};
    const resolved: Record<string, string | number | boolean> = {};
    for (const param of shown) {
      if (param.defaultFrom === undefined) continue;
      const value = defaultFor(param, projectShape, enumOptionsFor(param, capabilityOptions));
      if (value !== undefined) resolved[param.key] = value;
    }
    return resolved;
  }, [capabilityOptions, projectShape, shown]);

  const values = useMemo(() => ({ ...defaults, ...derived, ...params }), [defaults, derived, params]);

  // What is standing between the user and a run, as a value the button and the fields both read, so a
  // greyed button and an unmarked field cannot disagree about which input is missing.
  const blockers = useMemo(
    () => runBlockers({ manifest, status: record.status, values }),
    [manifest, record.status, values],
  );
  const blocked = new Set(
    blockers.filter((blocker) => blocker.param !== undefined).map((blocker) => blocker.param as string),
  );
  const reason = describeBlockers(blockers);

  const plan = useMemo(
    () =>
      planVariants({
        manifest,
        nextSeed: () => 0,
        ...(variantCount !== undefined ? { requested: variantCount } : {}),
        ...(lockedSeed !== undefined ? { lockedSeed } : {}),
      }),
    [manifest, variantCount, lockedSeed],
  );

  return (
    <section
      aria-label={`${manifest.name} parameters`}
      className={cn(
        // Fills its column rather than dictating it: the panel is mounted inside a resizable inspector,
        // and a fixed width there overflows by exactly the padding.
        'flex w-full flex-col gap-5 overflow-hidden p-4',
        // A greyed panel must still be readable: the spec's point is that the user can see what is wrong,
        // not merely that something is.
        !runnable && 'opacity-75',
      )}
    >
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <SparklesIcon className="size-3.5 text-chart-4" />
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Generate</span>
          <StatusBadge record={record} />
        </div>

        <span className="text-sm font-semibold">{manifest.name}</span>

        <CapabilityBadges manifest={manifest} />

        {!runnable && (
          // The spec's rule: an unrunnable generator stays visible with a concrete reason.
          <p className="flex items-start gap-1.5 font-mono text-xs text-destructive">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {describeRecord(record)}
          </p>
        )}
      </header>

      {manifest.presets.length > 0 && (
        <PresetChooser
          manifest={manifest}
          selected={preset}
          {...(onChangePreset !== undefined ? { onSelect: onChangePreset } : {})}
        />
      )}

      <div className="flex flex-col gap-4 overflow-auto">
        {shown.map((param) => (
          <ParamControl
            key={param.key}
            param={param}
            value={values[param.key]}
            disabled={!runnable}
            missing={blocked.has(param.key)}
            {...(capabilityOptions !== undefined ? { capabilityOptions } : {})}
            {...(isAssetParam(param) ? { choices: choicesFor(param, assetChoices ?? []) } : {})}
            {...(frameGrab !== undefined && param.type === 'image' ? { frameGrab } : {})}
            {...(param.type === 'seed' ? { seedLocked: lockedSeed !== undefined } : {})}
            {...(onChangeParam !== undefined ? { onChange: onChangeParam } : {})}
            {...(onToggleSeedLock !== undefined ? { onToggleSeedLock } : {})}
          />
        ))}
      </div>

      <VariantControl
        manifest={manifest}
        plan={plan}
        disabled={!runnable}
        {...(variantCount !== undefined ? { requested: variantCount } : {})}
        {...(onChangeVariantCount !== undefined ? { onChange: onChangeVariantCount } : {})}
      />

      {/* Disabled *with its reason*, which is the standing rule for every disabled control here: a
          button that is merely grey teaches nothing, and this one used to be lit while the graph it
          would submit had an empty image slot. */}
      <Button
        onClick={onRun}
        disabled={reason !== undefined}
        {...(reason !== undefined ? { title: `Cannot run: ${reason}` } : {})}
      >
        <SparklesIcon />
        Generate {plan.totalVariants > 1 ? `${plan.totalVariants} variants` : ''}
      </Button>

      {reason !== undefined && runnable && (
        <p className="flex items-start gap-1.5 font-mono text-xs text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {reason}
        </p>
      )}
    </section>
  );
}

function StatusBadge({ record }: { readonly record: RegistryRecord }): ReactNode {
  switch (record.status) {
    case 'available':
      return (
        <Badge variant="secondary" className="ml-auto text-chart-2">
          ready
        </Badge>
      );
    case 'unbound':
      // Distinct from unavailable: nothing is broken, the graph simply is not connected.
      return (
        <Badge variant="outline" className="ml-auto">
          graph not connected
        </Badge>
      );
    default:
      return (
        <Badge variant="destructive" className="ml-auto">
          unavailable
        </Badge>
      );
  }
}

/**
 * The consumes/produces badges from mockup 1c.
 *
 * Shown because they are what determines *where* the generator appears, and a user who cannot see them has
 * no way to reason about why a tool is or is not in a given menu.
 */
function CapabilityBadges({ manifest }: { readonly manifest: GeneratorManifest }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {manifest.consumes.map((descriptor) => (
        <Badge key={`${descriptor.type}-${descriptor.role ?? ''}`} variant="outline">
          {descriptor.role === undefined ? descriptor.type : `${descriptor.type} · ${descriptor.role}`}
        </Badge>
      ))}
      {manifest.consumes.length > 0 && (
        <ArrowRightIcon aria-hidden="true" className="size-3 text-muted-foreground" />
      )}
      <Badge variant="secondary" className="text-chart-4">
        {manifest.produces}
      </Badge>
      <Badge variant={manifest.duration === 'discovered' ? 'outline' : 'secondary'}>
        {manifest.duration === 'discovered' ? 'length discovered' : 'length declared'}
      </Badge>
    </div>
  );
}

function PresetChooser({
  manifest,
  selected,
  onSelect,
}: {
  readonly manifest: GeneratorManifest;
  readonly selected: PresetId | undefined;
  readonly onSelect?: (preset: PresetId | undefined) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Preset</span>
      <ToggleGroup
        aria-label="Preset"
        value={selected === undefined ? [] : [selected]}
        // Clicking the chosen preset clears it, which is why the whole set is read rather than the last
        // entry: "no preset" is a legitimate state and the manifest's own defaults apply in it.
        onValueChange={(next) => onSelect?.(next.at(-1) as PresetId | undefined)}
        className="flex-wrap justify-start"
      >
        {manifest.presets.map((entry) => (
          <ToggleGroupItem key={entry.id} value={entry.id}>
            {entry.name}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * One parameter control, chosen by declared type.
 *
 * The switch is over *types*, never over generator or parameter ids — that is what keeps the panel
 * generic. A new parameter type is a case here; a new generator is nothing at all.
 */
function ParamControl({
  param,
  value,
  disabled,
  missing = false,
  capabilityOptions,
  choices,
  frameGrab,
  seedLocked,
  onChange,
  onToggleSeedLock,
}: {
  readonly param: GeneratorParam;
  readonly value: string | number | boolean | undefined;
  readonly disabled: boolean;
  /** True when this required parameter is what is holding the run back. */
  readonly missing?: boolean;
  readonly capabilityOptions?: ReadonlyMap<string, readonly string[]>;
  readonly choices?: readonly AssetChoice[];
  readonly frameGrab?: FrameGrabOffer;
  /**
   * The project's shape, for parameters whose sensible default depends on it.
   *
   * A generator defaulting to a square output in a 16:9 sequence is pillarboxed the moment it lands
   * on the timeline — which is what "it generates badly" turns out to mean. The manifest cannot know
   * the sequence, so it declares what to derive from and this supplies the project.
   */
  readonly projectShape?: { readonly width: number; readonly height: number };
  readonly seedLocked?: boolean;
  readonly onChange?: (key: string, value: string | number | boolean) => void;
  readonly onToggleSeedLock?: () => void;
}): ReactNode {
  const label = param.label ?? param.key;
  const id = `param-${param.key}`;

  return (
    <Field className="gap-2">
      <FieldLabel htmlFor={id} className="text-xs">
        {label}
        {param.required === true && (
          <span aria-hidden="true" className="text-destructive">
            {' *'}
          </span>
        )}
      </FieldLabel>

      {param.type === 'text' && (
        <Textarea
          id={id}
          disabled={disabled}
          rows={param.multiline === true ? 3 : 1}
          value={String(value ?? '')}
          onChange={(event) => onChange?.(param.key, event.target.value)}
        />
      )}

      {(param.type === 'int' || param.type === 'float') && (
        <div className="flex items-center gap-2">
          {param.min !== undefined && param.max !== undefined && (
            <Slider
              aria-label={`${label} slider`}
              disabled={disabled}
              min={param.min}
              max={param.max}
              step={param.step ?? (param.type === 'int' ? 1 : 0.01)}
              // The array form even for one value: given a scalar the registry falls back to
              // `[min, max]` and renders a second thumb.
              value={[Number(value ?? param.default ?? param.min)]}
              onValueChange={(next) => onChange?.(param.key, Array.isArray(next) ? (next[0] ?? 0) : next)}
              className="flex-1"
            />
          )}
          <Input
            id={id}
            type="number"
            disabled={disabled}
            min={param.min}
            max={param.max}
            step={param.step ?? (param.type === 'int' ? 1 : 0.01)}
            // The manifest's default, not zero: an untouched field showing 0 tells the user the
            // generator will run with 0 when it will in fact run with 50.
            value={Number(value ?? param.default ?? 0)}
            onChange={(event) => onChange?.(param.key, Number(event.target.value))}
            className="w-19 font-mono tabular-nums"
          />
        </div>
      )}

      {param.type === 'bool' && (
        <Switch
          id={id}
          disabled={disabled}
          checked={value === true}
          onCheckedChange={(next) => onChange?.(param.key, next)}
          className="self-start"
        />
      )}

      {param.type === 'enum' && (
        <NativeSelect
          id={id}
          className="w-full"
          disabled={disabled}
          value={String(value ?? '')}
          onChange={(event) => onChange?.(param.key, event.target.value)}
        >
          {enumOptionsFor(param, capabilityOptions).map((option) => (
            <NativeSelectOption key={option} value={option}>
              {option}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}

      {param.type === 'seed' && (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            readOnly
            value={seedLocked === true ? String(value ?? 0) : 'random'}
            className="flex-1 font-mono tabular-nums"
          />
          <Button
            variant={seedLocked === true ? 'secondary' : 'outline'}
            size="icon"
            disabled={disabled}
            onClick={onToggleSeedLock}
            aria-pressed={seedLocked === true}
            aria-label={seedLocked === true ? 'Seed locked' : 'Lock the seed'}
            title="Locking the seed fixes the result, so every run is identical"
          >
            {seedLocked === true ? <LockIcon /> : <LockOpenIcon />}
          </Button>
        </div>
      )}

      {isAssetParam(param) && (
        <AssetField
          id={id}
          label={label}
          value={value === undefined ? '' : String(value)}
          disabled={disabled}
          missing={missing}
          choices={choices ?? []}
          paramKey={param.key}
          {...(frameGrab !== undefined ? { frameGrab } : {})}
          {...(onChange !== undefined ? { onChange: (next) => onChange(param.key, next) } : {})}
        />
      )}
    </Field>
  );
}

/**
 * The control for a parameter that names a file.
 *
 * A select over the project's own files rather than a system file dialog. Two reasons, and both are
 * the spec's: a project *is* a folder, so the files that belong to it are exactly the ones already in
 * it; and a graph is submitted with a project-relative path, so a file chosen from somewhere else on
 * the disk would produce a run nobody could reproduce later.
 *
 * When the project holds nothing of the required type the control says so rather than presenting an
 * empty list — "no images in this project yet" is actionable, an empty dropdown is a dead end.
 */
function AssetField({
  id,
  label,
  value,
  disabled,
  missing,
  choices,
  paramKey,
  frameGrab,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly missing: boolean;
  readonly choices: readonly AssetChoice[];
  readonly paramKey: string;
  readonly frameGrab?: FrameGrabOffer;
  /**
   * The project's shape, for parameters whose sensible default depends on it.
   *
   * A generator defaulting to a square output in a 16:9 sequence is pillarboxed the moment it lands
   * on the timeline — which is what "it generates badly" turns out to mean. The manifest cannot know
   * the sequence, so it declares what to derive from and this supplies the project.
   */
  readonly projectShape?: { readonly width: number; readonly height: number };
  readonly onChange?: (value: string) => void;
}): ReactNode {
  // A value the project no longer contains is kept as its own option rather than silently snapping
  // to the first file: a deleted or renamed asset must show as the thing that is wrong, and a select
  // whose value is absent from its options resets itself, which would change the run without saying so.
  const known = choices.some((choice) => choice.path === value);
  const grabbable = frameGrab !== undefined && frameGrab.describe !== undefined;

  return (
    <div className="flex flex-col gap-2">
      {choices.length === 0 && value === '' ? (
        <Input readOnly value={`no ${label.toLowerCase()} available in this project`} />
      ) : (
        <NativeSelect
          id={id}
          aria-label={label}
          disabled={disabled}
          value={value}
          // `aria-invalid` is what paints a required slot the run is waiting on: the registry's own
          // invalid state, rather than a red border decided here.
          aria-invalid={missing}
          onChange={(event) => onChange?.(event.target.value)}
          className="w-full max-w-full"
        >
          <NativeSelectOption value="">not set</NativeSelectOption>
          {!known && value !== '' && (
            <NativeSelectOption value={value}>{`${value} — missing`}</NativeSelectOption>
          )}
          {choices.map((choice) => (
            <NativeSelectOption key={choice.path} value={choice.path}>
              {choice.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}

      {frameGrab !== undefined && (
        // Shown disabled rather than hidden when there is nothing under the playhead: a control that
        // comes and goes as the playhead moves is harder to learn than one that says why it cannot act.
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !grabbable || frameGrab.busy === true}
          onClick={() => frameGrab.grab(paramKey)}
          title={
            grabbable
              ? `Grab ${frameGrab.describe} into the project and use it here`
              : 'Move the playhead over a video clip to grab a frame'
          }
        >
          <CameraIcon />
          {frameGrab.busy === true ? 'Grabbing…' : 'Use current frame'}
        </Button>
      )}
    </div>
  );
}

/**
 * Options for an enum parameter.
 *
 * A manifest may declare a static list or defer to the backend. The live path is what keeps model and
 * sampler lists reflecting reality rather than what was installed when the manifest was written.
 */
function enumOptionsFor(
  param: GeneratorParam,
  capabilityOptions: ReadonlyMap<string, readonly string[]> | undefined,
): readonly string[] {
  const options = param.options;
  if (options === undefined) return [];
  if (Array.isArray(options)) return options;

  const live = options as { from: 'capabilities'; nodeClass?: string; input?: string };
  if (live.nodeClass === undefined || live.input === undefined) return [];
  return capabilityOptions?.get(`${live.nodeClass}/${live.input}`) ?? [];
}

/**
 * The variant count control.
 *
 * Disabled with its reason shown when the manifest cannot vary anything. The spec is explicit that the UI
 * must explain rather than silently return identical results.
 */
function VariantControl({
  manifest,
  plan,
  requested,
  disabled,
  onChange,
}: {
  readonly manifest: GeneratorManifest;
  readonly plan: ReturnType<typeof planVariants>;
  readonly requested?: number;
  readonly disabled: boolean;
  readonly onChange?: (count: number) => void;
}): ReactNode {
  const canVary = supportsVariants(manifest) && plan.constraint?.kind !== 'seed-locked';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Variants</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{plan.mode}</span>
      </div>

      <Input
        type="number"
        aria-label="Variant count"
        min={1}
        max={16}
        disabled={disabled || !canVary}
        value={requested ?? plan.totalVariants}
        onChange={(event) => onChange?.(Number(event.target.value))}
        className="w-19 font-mono tabular-nums"
      />

      {plan.constraint !== undefined && (
        <p className="flex items-start gap-1.5 font-mono text-xs text-muted-foreground">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {describeConstraint(plan.constraint)}
        </p>
      )}
    </div>
  );
}
