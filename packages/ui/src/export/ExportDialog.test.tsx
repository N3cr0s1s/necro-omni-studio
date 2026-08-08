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

describe('rendering', () => {
  it('is a labelled modal dialog', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Export' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('summarizes the deliverable', () => {
    renderDialog();
    expect(screen.getByText('1920×1080 · 30 · H.264 high')).toBeDefined();
  });

  it('shows the destination', () => {
    renderDialog();
    expect(screen.getByText('renders/breakdown_v3.mp4')).toBeDefined();
  });

  it('says when no destination is set rather than showing an empty field', () => {
    renderDialog({ settings: settings({ outputPath: '' }) });
    expect(screen.getByText('not set')).toBeDefined();
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
    const codecs = screen.getAllByRole('radio').map((radio) => radio.textContent);
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

    await user.click(screen.getByRole('radio', { name: 'H.265' }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ videoCodec: 'h265' }));
  });

  it('reports a quality change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderDialog({ onChange });

    await user.click(screen.getByRole('radio', { name: 'maximum' }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ quality: 'maximum' }));
  });

  it('marks the selected option with aria-checked, not only a tint', () => {
    renderDialog();
    const selected = screen
      .getAllByRole('radio')
      .filter((radio) => radio.getAttribute('aria-checked') === 'true')
      .map((radio) => radio.textContent);
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
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.hasAttribute('disabled')).toBe(true);
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
