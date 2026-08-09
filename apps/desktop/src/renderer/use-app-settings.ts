import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../main/app-settings.js';
import { bridge } from './bridge.js';

/**
 * Settings that belong to the installation rather than to a project.
 *
 * §5.8's global override of the variant count is the first of them, and the job queue has taken a
 * ceiling since it was written — nothing ever set it, because there was nowhere for an
 * application-level setting to live.
 *
 * ## Why `undefined` until it is read
 *
 * The stored value arrives a moment after the window does, and guessing in the meantime is worse than
 * waiting: standing in a default the user has changed would refuse work they had explicitly allowed,
 * for the first run of every session. Callers treat `undefined` as "no ceiling yet" rather than as a
 * value, which is why the queue's option is optional too.
 *
 * The write answers with what was actually stored, so a value the main process clamped comes back
 * clamped rather than leaving the control showing something the file does not contain.
 */

export interface AppSettingsState {
  /** The stored settings, or `undefined` until the first read lands. */
  readonly settings: AppSettings | undefined;
  update(patch: Partial<AppSettings>): void;
}

export function useAppSettings(): AppSettingsState {
  const [settings, setSettings] = useState<AppSettings | undefined>(undefined);

  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;

    let cancelled = false;
    void Promise.resolve()
      .then(() => api.appSettings())
      .then((stored) => {
        if (!cancelled) setSettings(stored);
      })
      // A build with no bridge, or an older preload without the method: the defaults the main process
      // would have supplied are not available here, so the state stays `undefined` and every caller
      // goes on as though no ceiling were set. That is the same behaviour as before the setting existed.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    const api = bridge();
    if (api === undefined) return;
    // Stored first, then shown. Showing the requested value and correcting it afterwards makes a
    // clamped setting look like a control that fights the user.
    void api
      .updateAppSettings(patch)
      .then(setSettings)
      .catch(() => undefined);
  }, []);

  return { settings, update };
}
