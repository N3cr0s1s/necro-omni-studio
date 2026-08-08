import { describe, expect, it } from 'vitest';
import { PROVENANCE_SUFFIX as PACKAGE_SUFFIX } from '@nos/generators';
import { IPC, IPC_EVENTS, PROVENANCE_SUFFIX, isOpenableLink } from './ipc-contract.js';

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

/**
 * Which links a note may open.
 *
 * Checked in the main process because that is where the decision cannot be bypassed: the URL comes
 * from a markdown file in the project folder — from a client, a download, a generator — and the scheme
 * is the whole of the danger.
 */
describe('opening a link from a note', () => {
  it('allows the two schemes a reference is written in', () => {
    expect(isOpenableLink('https://example.com/brief')).toBe(true);
    expect(isOpenableLink('http://127.0.0.1:8188')).toBe(true);
  });

  it('refuses a local path, which the shell would open', () => {
    expect(isOpenableLink('file:///etc/passwd')).toBe(false);
    expect(isOpenableLink('file://C:/Windows/System32/cmd.exe')).toBe(false);
  });

  it('refuses a scheme a registered handler could act on', () => {
    // On Windows several of these are invocable with arguments, which is a shell out of a text file.
    for (const url of ['javascript:alert(1)', 'ms-msdt:/id', 'vscode://x', 'data:text/html,<b>']) {
      expect(isOpenableLink(url)).toBe(false);
    }
  });

  it('refuses anything that is not a URL, rather than throwing', () => {
    // Prose that looked like a link, or a relative path — both are ordinary content in a note.
    for (const text of ['', 'notes/other.md', 'see the brief', '://']) {
      expect(isOpenableLink(text)).toBe(false);
    }
  });
});
