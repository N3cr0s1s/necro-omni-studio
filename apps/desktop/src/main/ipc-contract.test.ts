import { describe, expect, it } from 'vitest';
import { PROVENANCE_SUFFIX as PACKAGE_SUFFIX } from '@nos/generators';
import { IPC, IPC_EVENTS, PROVENANCE_SUFFIX } from './ipc-contract.js';

describe('the provenance suffix', () => {
  it('is the same string on both sides of the boundary', () => {
    // Mirrored rather than imported, because the main process runs unbundled and cannot take a value
    // import from a workspace package. This is what keeps the mirror honest: the renderer names a
    // record with the package's constant and the main process appends its own, so a change to one
    // without the other would write records nothing could ever find.
    expect(PROVENANCE_SUFFIX).toBe(PACKAGE_SUFFIX);
  });
});

describe('the channel list', () => {
  it('has no duplicate channel names', () => {
    // Two entries sharing a name would silently route one capability's calls to the other's handler.
    const names = Object.values(IPC);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps push channels out of the invoke list', () => {
    // A push channel is data the renderer must be ready to receive; an invoke channel is a
    // capability it may use. Mixing them makes the boundary's risk impossible to read off.
    const invoked = new Set<string>(Object.values(IPC));
    for (const pushed of Object.values(IPC_EVENTS)) expect(invoked.has(pushed)).toBe(false);
  });
});
