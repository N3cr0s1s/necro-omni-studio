import { type ReactNode, useMemo } from 'react';
import type { PresetId } from '@nos/core';
import {
  type GeneratorManifest,
  type GeneratorParam,
  type RegistryRecord,
  describeConstraint,
  describeRecord,
  effectiveDefaults,
  planVariants,
  supportsVariants,
  visibleParams,
} from '@nos/generators';
import { Badge, Button, Mono, SectionCaption, ValueField } from '../primitives/Primitives.js';
import { token } from '../tokens/tokens.js';

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

  readonly onChangeParam?: (key: string, value: string | number | boolean) => void;
  readonly onChangePreset?: (preset: PresetId | undefined) => void;
  readonly onChangeVariantCount?: (count: number) => void;
  readonly onToggleSeedLock?: () => void;
  readonly onRun?: () => void;
}

export function GeneratorPanel({
  record,
  preset,
  params,
  variantCount,
  lockedSeed,
  capabilityOptions,
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
      style={{
        width: token.inspectorWidth,
        display: 'flex',
        flexDirection: 'column',
        gap: token.space5,
        padding: token.space6,
        background: token.bgPanel,
        borderLeft: `1px solid ${token.border}`,
        // A greyed panel must still be readable: the spec's point is that the user can see what is wrong,
        // not merely that something is.
        opacity: runnable ? 1 : 0.75,
        overflow: 'hidden',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: token.space3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: token.space3 }}>
          <SectionCaption>Generate</SectionCaption>
          <div style={{ flex: 1 }} />
          <StatusBadge record={record} />
        </div>

        <span style={{ font: `600 13px ${token.fontUi}`, color: token.textPrimary }}>{manifest.name}</span>

        <CapabilityBadges manifest={manifest} />

        {!runnable && (
          // The spec's rule: an unrunnable generator stays visible with a concrete reason.
          <Mono tone={record.status === 'unbound' ? token.warn : token.danger}>{describeRecord(record)}</Mono>
        )}
      </header>

      {manifest.presets.length > 0 && (
        <PresetChooser
          manifest={manifest}
          selected={preset}
          {...(onChangePreset !== undefined ? { onSelect: onChangePreset } : {})}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: token.space4, overflow: 'auto' }}>
        {shown.map((param) => (
          <ParamControl
            key={param.key}
            param={param}
            value={params[param.key] ?? defaults[param.key]}
            disabled={!runnable}
            {...(capabilityOptions !== undefined ? { capabilityOptions } : {})}
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

      <Button tone="primary" onClick={onRun} disabled={!runnable}>
        Generate {plan.totalVariants > 1 ? `${plan.totalVariants} variants` : ''}
      </Button>
    </section>
  );
}

function StatusBadge({ record }: { readonly record: RegistryRecord }): ReactNode {
  switch (record.status) {
    case 'available':
      return <Badge tone="ok">ready</Badge>;
    case 'unbound':
      // Distinct from unavailable: nothing is broken, the graph simply is not connected.
      return <Badge tone="warn">graph not connected</Badge>;
    default:
      return <Badge tone="danger">unavailable</Badge>;
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
    <div style={{ display: 'flex', gap: token.space2, flexWrap: 'wrap', alignItems: 'center' }}>
      {manifest.consumes.map((descriptor) => (
        <Badge key={`${descriptor.type}-${descriptor.role ?? ''}`} tone="neutral">
          {descriptor.role === undefined ? descriptor.type : `${descriptor.type} · ${descriptor.role}`}
        </Badge>
      ))}
      {manifest.consumes.length > 0 && <Mono tone={token.textGhost}>→</Mono>}
      <Badge tone="generated">{manifest.produces}</Badge>
      <Badge tone={manifest.duration === 'discovered' ? 'warn' : 'neutral'}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space2 }}>
      <SectionCaption>Preset</SectionCaption>
      <div
        role="radiogroup"
        aria-label="Preset"
        style={{ display: 'flex', gap: token.space1, flexWrap: 'wrap' }}
      >
        {manifest.presets.map((entry) => {
          const active = selected === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onSelect?.(active ? undefined : entry.id)}
              style={{
                height: token.controlHeightSm,
                padding: `0 ${token.space3}`,
                borderRadius: token.radiusControl,
                background: active ? '#1c2333' : token.surface2,
                border: `1px solid ${active ? '#2f4a72' : token.borderControl}`,
                color: active ? '#9dc2ff' : token.textMuted,
                font: `500 11px ${token.fontUi}`,
                cursor: 'pointer',
              }}
            >
              {entry.name}
            </button>
          );
        })}
      </div>
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
  capabilityOptions,
  seedLocked,
  onChange,
  onToggleSeedLock,
}: {
  readonly param: GeneratorParam;
  readonly value: string | number | boolean | undefined;
  readonly disabled: boolean;
  readonly capabilityOptions?: ReadonlyMap<string, readonly string[]>;
  readonly seedLocked?: boolean;
  readonly onChange?: (key: string, value: string | number | boolean) => void;
  readonly onToggleSeedLock?: () => void;
}): ReactNode {
  const label = param.label ?? param.key;
  const id = `param-${param.key}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space2 }}>
      <label htmlFor={id} style={{ font: token.textLabel, color: token.textSoft }}>
        {label}
        {param.required === true && (
          <span aria-hidden="true" style={{ color: token.danger }}>
            {' *'}
          </span>
        )}
      </label>

      {param.type === 'text' && (
        <textarea
          id={id}
          disabled={disabled}
          rows={param.multiline === true ? 3 : 1}
          value={String(value ?? '')}
          onChange={(event) => onChange?.(param.key, event.target.value)}
          style={{
            background: token.surface1,
            border: `1px solid ${token.borderControl}`,
            borderRadius: token.radiusControl,
            color: token.textBright,
            font: `400 11.5px ${token.fontUi}`,
            padding: token.space3,
            resize: 'vertical',
          }}
        />
      )}

      {(param.type === 'int' || param.type === 'float') && (
        <div style={{ display: 'flex', gap: token.space2, alignItems: 'center' }}>
          {param.min !== undefined && param.max !== undefined && (
            <input
              type="range"
              aria-label={`${label} slider`}
              disabled={disabled}
              min={param.min}
              max={param.max}
              step={param.step ?? (param.type === 'int' ? 1 : 0.01)}
              value={Number(value ?? param.min)}
              onChange={(event) => onChange?.(param.key, Number(event.target.value))}
              style={{ flex: 1 }}
            />
          )}
          <input
            id={id}
            type="number"
            disabled={disabled}
            min={param.min}
            max={param.max}
            step={param.step ?? (param.type === 'int' ? 1 : 0.01)}
            value={Number(value ?? 0)}
            onChange={(event) => onChange?.(param.key, Number(event.target.value))}
            style={{
              width: 76,
              height: token.controlHeight,
              background: token.surface1,
              border: `1px solid ${token.borderControl}`,
              borderRadius: token.radiusControl,
              color: token.textBright,
              font: token.textValue,
              padding: `0 ${token.space3}`,
            }}
          />
        </div>
      )}

      {param.type === 'bool' && (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={value === true}
          disabled={disabled}
          onClick={() => onChange?.(param.key, value !== true)}
          style={{
            alignSelf: 'flex-start',
            height: token.controlHeight,
            padding: `0 ${token.space4}`,
            borderRadius: token.radiusControl,
            background: value === true ? '#1c2333' : token.surface2,
            border: `1px solid ${value === true ? '#2f4a72' : token.borderControl}`,
            color: value === true ? '#9dc2ff' : token.textMuted,
            font: `500 11px ${token.fontUi}`,
            cursor: 'pointer',
          }}
        >
          {value === true ? 'on' : 'off'}
        </button>
      )}

      {param.type === 'enum' && (
        <select
          id={id}
          disabled={disabled}
          value={String(value ?? '')}
          onChange={(event) => onChange?.(param.key, event.target.value)}
          style={{
            height: token.controlHeight,
            background: token.surface1,
            border: `1px solid ${token.borderControl}`,
            borderRadius: token.radiusControl,
            color: token.textBright,
            font: `400 11.5px ${token.fontUi}`,
            padding: `0 ${token.space2}`,
          }}
        >
          {enumOptionsFor(param, capabilityOptions).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}

      {param.type === 'seed' && (
        <div style={{ display: 'flex', gap: token.space2, alignItems: 'center' }}>
          <ValueField style={{ flex: 1 }}>{seedLocked === true ? String(value ?? 0) : 'random'}</ValueField>
          <Button
            tone={seedLocked === true ? 'active' : 'default'}
            disabled={disabled}
            onClick={onToggleSeedLock}
            title="Locking the seed fixes the result, so every run is identical"
          >
            {seedLocked === true ? 'locked' : 'lock'}
          </Button>
        </div>
      )}

      {isAssetType(param.type) && <ValueField>{value === undefined ? 'not set' : String(value)}</ValueField>}
    </div>
  );
}

function isAssetType(type: GeneratorParam['type']): boolean {
  return type === 'image' || type === 'video' || type === 'audio' || type === 'mask';
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.space2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: token.space3 }}>
        <SectionCaption>Variants</SectionCaption>
        <div style={{ flex: 1 }} />
        <Mono tone={token.textFaint}>{plan.mode}</Mono>
      </div>

      <input
        type="number"
        aria-label="Variant count"
        min={1}
        max={16}
        disabled={disabled || !canVary}
        value={requested ?? plan.totalVariants}
        onChange={(event) => onChange?.(Number(event.target.value))}
        style={{
          width: 76,
          height: token.controlHeight,
          background: token.surface1,
          border: `1px solid ${token.borderControl}`,
          borderRadius: token.radiusControl,
          color: token.textBright,
          font: token.textValue,
          padding: `0 ${token.space3}`,
          opacity: canVary ? 1 : 0.5,
        }}
      />

      {plan.constraint !== undefined && <Mono tone={token.warn}>{describeConstraint(plan.constraint)}</Mono>}
    </div>
  );
}
