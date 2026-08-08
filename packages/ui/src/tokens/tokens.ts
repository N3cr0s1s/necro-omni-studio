import type { AssetType } from '@nos/media';

/**
 * Typed access to the CSS custom properties in `tokens.css`.
 *
 * Components reference tokens through these helpers rather than writing
 * `var(--nos-accent)` inline. Two reasons: a typo in a variable name fails silently in CSS (the
 * property resolves to nothing and the element renders unstyled), and the mappings below encode
 * *meaning* — which colour a generated clip gets, which swatch an asset type gets — in one place
 * instead of being re-decided at each call site.
 */

export const token = {
  bgApp: 'var(--nos-bg-app)',
  bgPanel: 'var(--nos-bg-panel)',
  bgCanvas: 'var(--nos-bg-canvas)',
  bgTimeline: 'var(--nos-bg-timeline)',
  surface1: 'var(--nos-surface-1)',
  surface2: 'var(--nos-surface-2)',
  surface3: 'var(--nos-surface-3)',
  surfaceSelected: 'var(--nos-surface-selected)',
  trackActive: 'var(--nos-track-active)',

  border: 'var(--nos-border)',
  borderSubtle: 'var(--nos-border-subtle)',
  borderControl: 'var(--nos-border-control)',

  textPrimary: 'var(--nos-text-primary)',
  textBright: 'var(--nos-text-bright)',
  textSecondary: 'var(--nos-text-secondary)',
  textMuted: 'var(--nos-text-muted)',
  textSoft: 'var(--nos-text-soft)',
  textDim: 'var(--nos-text-dim)',
  textFaint: 'var(--nos-text-faint)',
  textGhost: 'var(--nos-text-ghost)',

  accent: 'var(--nos-accent)',
  accentStrong: 'var(--nos-accent-strong)',
  generated: 'var(--nos-generated)',
  generatedText: 'var(--nos-generated-text)',
  generatedDim: 'var(--nos-generated-dim)',
  ok: 'var(--nos-ok)',
  okText: 'var(--nos-ok-text)',
  warn: 'var(--nos-warn)',
  warnText: 'var(--nos-warn-text)',
  mask: 'var(--nos-mask)',
  danger: 'var(--nos-danger)',

  fontUi: 'var(--nos-font-ui)',
  fontMono: 'var(--nos-font-mono)',

  textCaption: 'var(--nos-text-caption)',
  textLabel: 'var(--nos-text-label)',
  textBody: 'var(--nos-text-body)',
  textValue: 'var(--nos-text-value)',
  textMeta: 'var(--nos-text-meta)',
  textClip: 'var(--nos-text-clip)',
  textReadout: 'var(--nos-text-readout)',
  captionTracking: 'var(--nos-caption-tracking)',

  radiusInset: 'var(--nos-radius-inset)',
  radiusControl: 'var(--nos-radius-control)',
  radiusCard: 'var(--nos-radius-card)',
  radiusPanel: 'var(--nos-radius-panel)',

  space1: 'var(--nos-space-1)',
  space2: 'var(--nos-space-2)',
  space3: 'var(--nos-space-3)',
  space4: 'var(--nos-space-4)',
  space5: 'var(--nos-space-5)',
  space6: 'var(--nos-space-6)',
  space7: 'var(--nos-space-7)',

  controlHeight: 'var(--nos-control-height)',
  controlHeightSm: 'var(--nos-control-height-sm)',
  badgeHeight: 'var(--nos-badge-height)',
  panelHeaderHeight: 'var(--nos-panel-header-height)',
  browserWidth: 'var(--nos-browser-width)',
  inspectorWidth: 'var(--nos-inspector-width)',
  trackHeaderWidth: 'var(--nos-track-header-width)',
  rulerHeight: 'var(--nos-ruler-height)',
  timelineHeight: 'var(--nos-timeline-height)',
  transportHeight: 'var(--nos-transport-height)',
  titlebarHeight: 'var(--nos-titlebar-height)',

  transition: 'var(--nos-transition)',
  transitionFast: 'var(--nos-transition-fast)',
  focusRing: 'var(--nos-focus-ring)',
} as const;

export type TokenName = keyof typeof token;

/**
 * Swatch colour for an asset type, used by the media browser's row markers.
 *
 * Unknown types get the neutral swatch rather than being hidden: the spec allows arbitrary files in
 * the project folder, and a file the app cannot type is still a file the user put there.
 */
export function assetSwatch(type: AssetType | undefined): string {
  switch (type) {
    case 'video':
      return 'var(--nos-asset-video)';
    case 'audio':
      return 'var(--nos-asset-audio)';
    case 'image':
      return 'var(--nos-asset-image)';
    case 'text':
      return 'var(--nos-asset-text)';
    case 'mask':
      return 'var(--nos-mask)';
    default:
      return 'var(--nos-asset-unknown)';
  }
}

/**
 * Swatch colour for a reserved project folder.
 *
 * These follow the accent meanings rather than the asset-type swatches: `generated/` is purple
 * because everything in it came from a generator, `masks/` is the mask accent, `cache/` is muted
 * because it is derived and disposable.
 */
export function folderSwatch(name: string): string {
  switch (name) {
    case 'media':
      return token.accent;
    case 'generated':
      return token.generated;
    case 'masks':
      return token.mask;
    case 'effects':
      return token.ok;
    case 'generators':
      return token.generated;
    case 'notes':
      return token.warn;
    case 'renders':
      return 'var(--nos-asset-image)';
    case 'cache':
      return token.borderControl;
    default:
      return 'var(--nos-asset-image)';
  }
}

/**
 * Whether a clip should be drawn with the generated (purple) treatment.
 *
 * A single predicate so the rule "purple means a generator made this" cannot be applied
 * inconsistently between the timeline, the browser and the inspector.
 */
export function isGeneratedTreatment(hasProvenance: boolean): boolean {
  return hasProvenance;
}
