// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_RATES, frameIndex, spanFromBounds } from '@nos/core';
import { DEFAULT_EXPORT, type ExportProgress, type ExportSettings } from '@nos/export';
import { ExportDialog } from './ExportDialog.js';

afterEach(cleanup);

function settings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputPath: 'renders/breakdown_v3.mp4',
    range: spanFromBounds(frameIndex(0), frameIndex(300)),
    resolution: { width: 1920, height: 1080 },
    frameRate: FRAME_RATES.WEB_30,
    ...DEFAULT_EXPORT,
    ...overrides,
  };
}

function progress(overrides: Partial<ExportProgress> = {}): ExportProgress {
  return {
    phase: 'rendering',
    framesDone: 75,
    framesTotal: 300,
    fraction: 0.25,
    fps: 12.5,
    remainingSeconds: 18,
    ...overrides,
  };
}

function renderDialog(overrides: Partial<Parameters<typeof ExportDialog>[0]> = {}) {
  return render(<ExportDialog settings={settings()} {...overrides} />);
}

/**
 * The options of one segmented choice, by the label beside it. Reading them off the group rather than
 * off every pressed button in the dialog keeps the codec assertions from picking up the quality ones.
 */
function optionsOf(label: string): (string | null)[] {
  const field = screen.getByText(label).closest('[data-slot="field"]');
  return [...(field?.querySelectorAll('button') ?? [])].map((option) => option.textContent);
}

describe('rendering', () => {
  it('is a labelled modal dialog', () => {
    // The modality itself is the registry's — backdrop, focus trap, Escape. What is asserted here is
    // that it is reachable *as* a dialog and that it says which one it is.
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Export' })).toBeDefined();
  });

  it('summarizes the deliverable', () => {
    renderDialog();
    expect(screen.getByText('1920×1080 · 30 · H.264 high')).toBeDefined();
  });

  it('shows the destination', () => {
    renderDialog();
    expect(screen.getByLabelText('Save to')).toHaveProperty('value', 'renders/breakdown_v3.mp4');
  });

  it('says when no destination is set rather than showing an empty field', () => {
    renderDialog({ settings: settings({ outputPath: '' }) });
    expect(screen.getByLabelText('Save to')).toHaveProperty('placeholder', 'not set');
  });

  it('shows the range in frames and seconds', () => {
    renderDialog();
    expect(screen.getByText('300 f · 10.0 s')).toBeDefined();
  });

  it('estimates the output size', () => {
    renderDialog();
    expect(screen.getByText(/^about .+(MB|GB|KB)$/)).toBeDefined();
  });

  it('offers only the codecs the pipeline implements', () => {
    // Offering a codec that is not implemented would imply capability that is not there.
    renderDialog();
    const codecs = optionsOf('Codec');
    expect(codecs).toContain('H.264');
    expect(codecs).toContain('H.265');
    expect(codecs).not.toContain('ProRes');
  });
});

describe('settings changes', () => {
  it('reports a codec change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderDialog({ onChange });

    await user.click(screen.getByRole('button', { name: 'H.265' }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ videoCodec: 'h265' }));
  });

  it('reports a quality change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderDialog({ onChange });

    await user.click(screen.getByRole('button', { name: 'maximum' }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ quality: 'maximum' }));
  });

  it('marks the selected option in the accessibility tree, not only with a tint', () => {
    renderDialog();
    const selected = screen.getAllByRole('button', { pressed: true }).map((option) => option.textContent);
    // One per group: codec, quality, speed.
    expect(selected).toEqual(['H.264', 'high', 'medium']);
  });

  it('opens a picker for the destination', async () => {
    const user = userEvent.setup();
    const onBrowse = vi.fn();
    renderDialog({ onBrowse });
    await user.click(screen.getByRole('button', { name: 'Browse' }));
    expect(onBrowse).toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('shows a problem next to the field that caused it', async () => {
    // Export is long; discovering a bad path after committing is a poor trade.
    renderDialog({ settings: settings({ outputPath: '' }) });
    expect(screen.getByText(/choose where to save/i)).toBeDefined();
  });

  it('explains a wrong extension, since the container is fixed', () => {
    renderDialog({ settings: settings({ outputPath: 'renders/out.mov' }) });
    expect(screen.getByText(/\.mp4/)).toBeDefined();
  });

  it('reports an odd resolution, which H.264 cannot encode', () => {
    renderDialog({ settings: settings({ resolution: { width: 1921, height: 1080 } }) });
    expect(screen.getByText(/even/)).toBeDefined();
  });

  it('disables export while settings are invalid', () => {
    renderDialog({ settings: settings({ outputPath: '' }) });
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toContain('Fix the highlighted');
  });

  it('enables export once settings are valid', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(false);
  });

  it('does not start an export while invalid', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    renderDialog({ settings: settings({ outputPath: '' }), onStart });
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('starts an export when valid', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    renderDialog({ onStart });
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(onStart).toHaveBeenCalled();
  });
});

describe('progress', () => {
  it('exposes a progress bar with its percentage', () => {
    renderDialog({ progress: progress() });
    const bar = screen.getByRole('progressbar', { name: 'Export progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
  });

  it('shows frames, rate and the remaining estimate', () => {
    renderDialog({ progress: progress() });
    expect(screen.getByText('75 / 300 f')).toBeDefined();
    expect(screen.getByText('12.5 fps')).toBeDefined();
    expect(screen.getByText('about 18 s remaining')).toBeDefined();
  });

  it('says it is estimating before there is a number', () => {
    // The key is omitted rather than set to undefined: under exactOptionalPropertyTypes those differ, and
    // "absent" is what the tracker actually produces before it has enough samples.
    const { remainingSeconds, ...withoutEstimate } = progress();
    void remainingSeconds;
    renderDialog({ progress: withoutEstimate });
    expect(screen.getByText('estimating…')).toBeDefined();
  });

  it('replaces the export button with cancel while running', () => {
    renderDialog({ progress: progress() });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('locks the settings while running, so they cannot drift from the render', () => {
    renderDialog({ progress: progress() });
    for (const option of screen.getAllByRole('button', { pressed: false })) {
      expect(option.hasAttribute('disabled')).toBe(true);
    }
    expect(screen.getByRole('button', { name: 'Browse' }).hasAttribute('disabled')).toBe(true);
  });

  it('reports a cancel request', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderDialog({ progress: progress(), onCancel });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('returns to an editable form when the export completes', () => {
    renderDialog({ progress: progress({ phase: 'complete', fraction: 1, framesDone: 300 }) });
    expect(screen.getByRole('button', { name: 'Export' })).toBeDefined();
    expect(screen.getByText('complete')).toBeDefined();
  });

  it('surfaces a failure message rather than a bare failed state', () => {
    renderDialog({
      progress: progress({ phase: 'failed', message: 'the encoder ran out of disk space' }),
    });
    expect(screen.getByText('the encoder ran out of disk space')).toBeDefined();
    // The form is editable again so the user can fix and retry.
    expect(screen.getByRole('button', { name: 'Export' })).toBeDefined();
  });
});

describe('proxy warning', () => {
  it('marks a proxy render, which must never ship silently', () => {
    renderDialog({ settings: settings({ useProxyResolution: true }) });
    expect(screen.getByText('proxy resolution')).toBeDefined();
  });

  it('shows no badge for a full-resolution export', () => {
    renderDialog();
    expect(screen.queryByText('proxy resolution')).toBeNull();
  });
});

describe('when it finishes', () => {
  const complete = {
    phase: 'complete' as const,
    fraction: 1,
    framesDone: 300,
    framesTotal: 300,
    fps: 24,
    remainingSeconds: 0,
  };

  it('names the file the reveal will show, rather than repeating the path', () => {
    // The destination is already in the field above; this adds the action, not a second copy of it.
    renderDialog({ progress: complete, onReveal: vi.fn() });
    expect(screen.getByTitle('Show renders/breakdown_v3.mp4 in the file manager')).toBeDefined();
  });

  it('offers to show it', () => {
    const onReveal = vi.fn();
    renderDialog({ progress: complete, onReveal });

    screen.getByText('Reveal').click();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to reveal while it is still running', () => {
    renderDialog({
      progress: { ...complete, phase: 'encoding', fraction: 0.5, framesDone: 150 },
    });
    expect(screen.queryByText('Reveal')).toBeNull();
  });

  it('says nothing about revealing when the shell cannot', () => {
    renderDialog({ progress: complete });
    expect(screen.queryByText('Reveal')).toBeNull();
  });
});

describe('the review copy', () => {
  it('is offered, and off', () => {
    // The badge warning about this setting has existed since the field was declared; nothing could
    // turn it on, so the one deliverable it exists for could not be produced.
    render(<ExportDialog open settings={settings()} />);
    const toggle = screen.getByRole('switch', { name: 'Review copy' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('says what a full export renders at until it is asked for', () => {
    render(<ExportDialog open settings={settings()} />);
    expect(screen.getByText('full resolution')).toBeDefined();
  });

  it('shows the size it would deliver instead', () => {
    // The size comes from the same rule the renderer uses, so the dialog cannot promise one size and
    // the file arrive at another.
    render(<ExportDialog open settings={settings({ useProxyResolution: true })} />);
    expect(screen.getByText('960×540')).toBeDefined();
  });

  it('reports the change rather than keeping it', () => {
    const onChange = vi.fn();
    render(<ExportDialog open settings={settings()} onChange={onChange} />);

    void userEvent.click(screen.getByRole('switch', { name: 'Review copy' }));

    return vi.waitFor(() => {
      expect(onChange.mock.calls.at(-1)?.[0]?.useProxyResolution).toBe(true);
    });
  });

  it('cannot be changed while an export is running', () => {
    // Base UI reports this as `aria-disabled`, not the `disabled` attribute — which is what a screen
    // reader reads and what the pointer handler checks.
    // `running` is derived from the progress phase, not passed — the dialog has one source of truth
    // for whether an export is in flight.
    render(<ExportDialog open settings={settings()} progress={progress()} />);
    expect(screen.getByRole('switch', { name: 'Review copy' }).getAttribute('aria-disabled')).toBe('true');
  });
});
