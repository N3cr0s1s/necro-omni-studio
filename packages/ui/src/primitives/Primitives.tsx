import type { CSSProperties, ReactNode } from 'react';
import { token } from '../tokens/tokens.js';

/**
 * Shared primitives.
 *
 * Small and unopinionated on purpose. The mockups are dense — a 34 px panel header, a 19 px badge,
 * a 26 px control — and those metrics repeat across every screen. Encoding them once means a new
 * panel matches the rest without measuring pixels from a screenshot.
 *
 * Styling is inline rather than in CSS modules. The reason is specific to this app: the timeline
 * computes positions per frame from zoom and scroll, so many components already need computed
 * styles, and splitting "static styling here, computed styling there" produced worse code than
 * keeping one mechanism. All values still come from `token`, so the palette stays centralized.
 */

export interface WithChildren {
  readonly children?: ReactNode | undefined;
}

export interface Styled {
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
}

/** Uppercase section caption: `PROJECT FOLDER`, `EFFECT STACK`, `TRANSFORM`. */
export function SectionCaption({ children, style }: WithChildren & Styled): ReactNode {
  return (
    <span
      style={{
        font: token.textCaption,
        letterSpacing: token.captionTracking,
        textTransform: 'uppercase',
        color: token.textDim,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** A panel header strip with a caption and optional trailing content. */
export function PanelHeader({
  caption,
  trailing,
  children,
}: {
  readonly caption?: string | undefined;
  readonly trailing?: ReactNode | undefined;
} & WithChildren): ReactNode {
  return (
    <div
      style={{
        height: token.panelHeaderHeight,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: token.space3,
        padding: `0 ${token.space5}`,
        borderBottom: `1px solid ${token.borderSubtle}`,
      }}
    >
      {caption !== undefined && <SectionCaption>{caption}</SectionCaption>}
      {children}
      {trailing !== undefined && (
        <>
          <div style={{ flex: 1 }} />
          {trailing}
        </>
      )}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'generated' | 'mask' | 'danger';

const BADGE_TONES: Readonly<Record<BadgeTone, { readonly fg: string; readonly bg: string }>> = {
  neutral: { fg: token.textMuted, bg: token.surface1 },
  accent: { fg: '#9dc2ff', bg: '#1c2333' },
  ok: { fg: token.okText, bg: 'rgba(56, 193, 164, 0.16)' },
  warn: { fg: token.warnText, bg: 'rgba(224, 164, 74, 0.16)' },
  generated: { fg: token.generatedText, bg: 'rgba(155, 140, 255, 0.16)' },
  mask: { fg: '#ff9c7a', bg: 'rgba(255, 122, 82, 0.16)' },
  danger: { fg: token.danger, bg: 'rgba(255, 107, 107, 0.16)' },
};

/**
 * A small status chip: `proxy 1080p`, `3 pass`, `fx 3`, `mask`.
 *
 * Monospace because most badge content is numeric, and a changing count must not reflow the row it
 * sits in.
 */
export function Badge({
  tone = 'neutral',
  children,
  style,
}: { readonly tone?: BadgeTone | undefined } & WithChildren & Styled): ReactNode {
  const colors = BADGE_TONES[tone];
  return (
    <span
      style={{
        height: token.badgeHeight,
        display: 'inline-flex',
        alignItems: 'center',
        padding: `0 ${token.space2}`,
        borderRadius: token.radiusInset,
        font: token.textValue,
        color: colors.fg,
        background: colors.bg,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** A coloured dot, for watcher state and effect health. */
export function StatusDot({
  color,
  size = 7,
  label,
}: {
  readonly color: string;
  readonly size?: number | undefined;
  /** Accessible name. A bare dot conveys nothing to a screen reader without one. */
  readonly label?: string | undefined;
}): ReactNode {
  return (
    <span
      role={label === undefined ? 'presentation' : 'img'}
      aria-label={label}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flex: 'none',
        display: 'inline-block',
      }}
    />
  );
}

/** Numeric or path text. Never used for prose. */
export function Mono({
  children,
  tone = token.textFaint,
  style,
}: { readonly tone?: string | undefined } & WithChildren & Styled): ReactNode {
  return <span style={{ font: token.textMeta, color: tone, ...style }}>{children}</span>;
}

export type ButtonTone = 'default' | 'primary' | 'active';

/**
 * A compact button.
 *
 * `active` renders the pressed state the mockups use for toggles like Snap, and sets
 * `aria-pressed` so the state is not conveyed by colour alone.
 */
export function Button({
  tone = 'default',
  onClick,
  disabled = false,
  title,
  children,
  style,
}: {
  readonly tone?: ButtonTone | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
} & WithChildren &
  Styled): ReactNode {
  const palette = {
    default: { bg: token.surface2, border: token.borderControl, fg: token.textMuted },
    primary: { bg: token.accentStrong, border: 'transparent', fg: '#ffffff' },
    active: { bg: '#1c2333', border: '#2f4a72', fg: '#9dc2ff' },
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={tone === 'active' ? true : undefined}
      style={{
        height: token.controlHeight,
        padding: `0 ${token.space4}`,
        borderRadius: token.radiusControl,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.fg,
        font: `500 11.5px ${token.fontUi}`,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: token.space2,
        transition: `background ${token.transitionFast}, border-color ${token.transitionFast}`,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** A vertical rule between toolbar groups. */
export function Divider(): ReactNode {
  return (
    <span
      role="presentation"
      style={{
        width: 1,
        height: 18,
        background: token.border,
        margin: `0 ${token.space1}`,
        flex: 'none',
      }}
    />
  );
}

/** Read-only inset field, as used throughout the inspector. */
export function ValueField({ children, style }: WithChildren & Styled): ReactNode {
  return (
    <div
      style={{
        height: token.controlHeight,
        borderRadius: token.radiusControl,
        background: token.surface1,
        border: `1px solid ${token.borderControl}`,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${token.space3}`,
        font: token.textValue,
        color: token.textBright,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Label-and-control row in the inspector, with the mockups' 66 px label column. */
export function FieldRow({ label, children }: { readonly label: string } & WithChildren): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: token.space4 }}>
      <span style={{ width: 66, flex: 'none', font: token.textLabel, color: token.textSoft }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', gap: token.space2, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/**
 * Empty-state placeholder with a dashed border, e.g. "+ Add effect from registry".
 *
 * A button rather than a div: it is interactive in every place the mockups use it, and keyboard
 * users need to reach it.
 */
export function DashedAction({
  onClick,
  children,
}: { readonly onClick?: (() => void) | undefined } & WithChildren): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 28,
        width: '100%',
        borderRadius: token.radiusCard,
        border: `1px dashed ${token.borderControl}`,
        background: 'transparent',
        color: token.textDim,
        font: `500 11px ${token.fontUi}`,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/**
 * Explains why a surface is empty.
 *
 * Deliberately a first-class component. The spec's rule that an unavailable generator must show a
 * concrete reason rather than vanishing applies just as much to empty panels: "no clip selected" is
 * information, a blank rectangle is not.
 */
export function EmptyState({
  message,
  detail,
}: {
  readonly message: string;
  readonly detail?: string | undefined;
}): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: token.space2,
        padding: token.space7,
        textAlign: 'center',
      }}
    >
      <span style={{ font: token.textLabel, color: token.textDim }}>{message}</span>
      {detail !== undefined && <Mono tone={token.textGhost}>{detail}</Mono>}
    </div>
  );
}
