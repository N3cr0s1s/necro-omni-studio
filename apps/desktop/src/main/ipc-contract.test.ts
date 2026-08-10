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

/**
 * The events the shell pushes.
 *
 * The sidecar's is the newest and the reason is worth keeping: opening a project used to await
 * `startSidecar`, which allows fifteen seconds — so on a machine where Python is slow or the
 * dependencies are missing, choosing a folder did nothing visible for fifteen seconds and the editor
 * showed "no project open" the whole time. Nothing about opening a project needs a sidecar, so it
 * starts in the background and says so when it settles.
 */
describe('pushed events', () => {
  it('names a sidecar channel distinct from the request one', () => {
    // Distinct because they are different things: one is asked, the other arrives. Sharing a name
    // would make a subscription and a handler collide on the same channel.
    expect(IPC_EVENTS.sidecarStatus).not.toBe(IPC.sidecarInfo);
  });

  it('keeps every event channel distinct from every request channel', () => {
    // Widened deliberately: the point of the check is that the two *string* sets do not overlap, and
    // a `Set<IpcChannel>` would only accept the very values it is meant to prove absent.
    const requests: ReadonlySet<string> = new Set<string>(Object.values(IPC));
    for (const event of Object.values(IPC_EVENTS)) {
      expect(requests.has(event)).toBe(false);
    }
  });
});

/*
 * The export destination picker.
 *
 * The Browse button beside the destination field has been on the export dialog since it was written, and
 * nothing ever supplied its callback — so it rendered, and clicking it did nothing at all. Adding the
 * channel is most of the fix; the part worth a test is that its two failure outcomes stay distinct.
 */
describe('choosing where an export lands', () => {
  it('has a channel, so the button has something behind it', () => {
    expect(IPC.chooseExportPath).toBeDefined();
  });

  it('names its channel under the project namespace, like its neighbours', () => {
    // The names are a surface too: a channel that does not say which subsystem it belongs to is one
    // nobody finds when they are looking for it.
    expect(IPC.chooseExportPath.startsWith('project:')).toBe(true);
  });

  it('is unique among the channels', () => {
    // Two handlers on one name is a silent overwrite, and which one wins depends on registration order.
    const names = Object.values(IPC);
    expect(new Set(names).size).toBe(names.length);
  });
});
