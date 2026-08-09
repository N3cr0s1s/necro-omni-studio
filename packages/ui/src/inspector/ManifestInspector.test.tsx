// @vitest-environment jsdom
import { type ReactNode, useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphLiteral, ManifestDraft } from '@nos/generators';
import {
  DERIVED_DEFAULTS,
  addOutput,
  draftManifestJson,
  editParam,
  emptyDraft,
  promote,
} from '@nos/generators';
import { ManifestInspector } from './ManifestInspector.js';

afterEach(cleanup);

const literals: readonly GraphLiteral[] = [
  { pointer: '/3/inputs/seed', nodeId: '3', nodeClass: 'KSampler', input: 'seed', value: 4471 },
  { pointer: '/3/inputs/steps', nodeId: '3', nodeClass: 'KSampler', input: 'steps', value: 20 },
  { pointer: '/7/inputs/text', nodeId: '7', nodeClass: 'CLIPTextEncode', input: 'text', value: 'a drone' },
];

const usable = (): ManifestDraft =>
  addOutput(
    emptyDraft({ id: 'my_gen', name: 'My Generator', graph: 'g.json', surfaces: ['media_browser'] }),
    { key: 'image', type: 'image', node: '9' },
  );

const renderInspector = (overrides: Partial<Parameters<typeof ManifestInspector>[0]> = {}) =>
  render(<ManifestInspector draft={usable()} literals={literals} {...overrides} />);

/**
 * Renders wired to real state, and hands back a reader for the current draft.
 *
 * Every field in this panel is controlled by the draft, so against a mocked handler it never advances:
 * each keystroke lands in a field that re-renders to its old value, and only the last survives. That
 * is a fact about how the panel is driven, not about the controls — anything that types more than one
 * character has to go through here.
 */
function renderLive(initial: ManifestDraft): () => ManifestDraft {
  let latest = initial;
  function Harness(): ReactNode {
    const [draft, setDraft] = useState(latest);
    latest = draft;
    return (
      <ManifestInspector
        draft={draft}
        literals={literals}
        onEditParam={(id, changes) => setDraft((now) => editParam(now, id, changes))}
      />
    );
  }
  render(<Harness />);
  return () => latest;
}

describe('listing the graph', () => {
  it('groups inputs by node, because a graph has hundreds of them', () => {
    renderInspector();
    expect(screen.getByText('KSampler')).toBeDefined();
    expect(screen.getByText('CLIPTextEncode')).toBeDefined();
  });

  it('shows each input with its current value', () => {
    renderInspector();
    expect(screen.getByLabelText('seed on KSampler 3')).toBeDefined();
    expect(screen.getByText('4471')).toBeDefined();
  });

  it('filters by node, input or value', async () => {
    const user = userEvent.setup();
    renderInspector();

    await user.type(screen.getByLabelText('Filter graph inputs'), 'CLIPText');
    expect(screen.queryByLabelText('seed on KSampler 3')).toBeNull();
    expect(screen.getByLabelText('text on CLIPTextEncode 7')).toBeDefined();
  });

  it('says so when no graph is loaded, rather than showing an empty column', () => {
    renderInspector({ literals: [] });
    expect(screen.getByText(/no graph inputs/)).toBeDefined();
  });
});

describe('promoting inputs', () => {
  it('reports a tick as a promotion', async () => {
    const user = userEvent.setup();
    const onPromote = vi.fn();
    renderInspector({ onPromote });

    await user.click(screen.getByLabelText('steps on KSampler 3'));
    expect(onPromote).toHaveBeenCalledWith(literals[1]);
  });

  it('shows a promoted input as ticked', () => {
    renderInspector({ draft: promote(usable(), literals[1]!) });
    // Base UI's checkbox is a button carrying `aria-checked`, not an `<input>` — so the tick is read
    // off the accessibility tree, which is also where a user of one would find it.
    expect(screen.getByLabelText('steps on KSampler 3').getAttribute('aria-checked')).toBe('true');
  });

  it('reports an untick as a demotion, by the parameter´s id', async () => {
    const user = userEvent.setup();
    const onDemote = vi.fn();
    renderInspector({ draft: promote(usable(), literals[1]!), onDemote });

    await user.click(screen.getByLabelText('steps on KSampler 3'));
    expect(onDemote).toHaveBeenCalledWith('/3/inputs/steps');
  });
});

describe('editing parameters', () => {
  const withParam = () => promote(usable(), literals[1]!);

  it('offers every parameter type, so the inferred one is a suggestion', () => {
    renderInspector({ draft: withParam() });
    const options = [...screen.getByLabelText('Type').querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(
      expect.arrayContaining(['text', 'int', 'float', 'bool', 'enum', 'seed', 'image']),
    );
  });

  it('reports a type change', async () => {
    const user = userEvent.setup();
    const onEditParam = vi.fn();
    renderInspector({ draft: withParam(), onEditParam });

    await user.selectOptions(screen.getByLabelText('Type'), 'float');
    expect(onEditParam).toHaveBeenCalledWith('/3/inputs/steps', { type: 'float' });
  });

  it('shows the pointer the parameter binds to', () => {
    renderInspector({ draft: withParam() });
    expect(screen.getAllByText(/\/3\/inputs\/steps/).length).toBeGreaterThan(0);
  });

  it('offers a range only for numeric types', () => {
    renderInspector({ draft: withParam() });
    expect(screen.getByLabelText('Min')).toBeDefined();

    cleanup();
    // A minimum on a string is meaningless, and offering meaningless fields teaches users to ignore all
    // of them.
    renderInspector({ draft: promote(usable(), literals[2]!) });
    expect(screen.queryByLabelText('Min')).toBeNull();
  });

  it('clears a range when the field is emptied', async () => {
    // A cleared box must remove the bound rather than write 0, which would pin the parameter to a range it
    // never had.
    const user = userEvent.setup();
    const onEditParam = vi.fn();
    const ranged = editParam(withParam(), '/3/inputs/steps', { min: 5 });
    renderInspector({ draft: ranged, onEditParam });

    await user.clear(screen.getByLabelText('Min'));
    expect(onEditParam).toHaveBeenLastCalledWith('/3/inputs/steps', { min: undefined });
  });

  it('says so when nothing has been promoted yet', () => {
    renderInspector();
    expect(screen.getByText(/tick a graph input/)).toBeDefined();
  });
});

describe('identity fields', () => {
  it('reports an edit', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderInspector({ onChange });

    await user.type(screen.getByLabelText('Name'), '!');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Generator!' }));
  });

  it('parses a comma list into surfaces', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderInspector({ draft: emptyDraft(), onChange });

    // Pasted rather than typed: the field is controlled by the draft, and a spy never feeds a keystroke
    // back, so typing would assert on the last character rather than on the parse.
    await user.click(screen.getByLabelText('Surfaces'));
    await user.paste('a, b');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ surfaces: ['a', 'b'] }));
  });

  it('treats an emptied graph field as not connected, not as a file named empty', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderInspector({ draft: emptyDraft({ graph: 'g' }), onChange });

    await user.clear(screen.getByLabelText('Graph file'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ graph: null }));
  });

  it('explains both length modes where the choice is made', () => {
    renderInspector();
    const options = [...screen.getByLabelText('Length').querySelectorAll('option')].map((o) => o.textContent);
    expect(options.join(' ')).toContain('a parameter sets it');
  });
});

describe('outputs', () => {
  it('offers the graph´s node ids rather than a free-text field', () => {
    // A typo in a node id makes the manifest unavailable with a message about a node that never existed.
    renderInspector({ nodeIds: ['9', '57'] });
    const options = [...screen.getByLabelText('Node').querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['', '9', '57']);
  });

  it('adds an output', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderInspector({ onChange });

    await user.click(screen.getByRole('button', { name: 'Add output' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ outputs: expect.arrayContaining([expect.objectContaining({ node: null })]) }),
    );
  });
});

describe('problems', () => {
  it('blocks saving while an error stands', () => {
    renderInspector({ draft: emptyDraft() });
    expect(screen.getByRole('button', { name: 'Save manifest' }).hasAttribute('disabled')).toBe(true);
  });

  it('lists what is wrong, with the path to the field', () => {
    renderInspector({ draft: emptyDraft() });
    const problems = within(screen.getByRole('list', { name: 'Draft problems' }));
    expect(problems.getByText('/id')).toBeDefined();
    expect(problems.getByText('an id is required')).toBeDefined();
  });

  it('lets an unbound manifest be saved, since the spec writes contracts before graphs', () => {
    // Blocking this would break the workflow the registry's `unbound` status exists for.
    const unbound = { ...usable(), graph: null };
    renderInspector({ draft: unbound });

    expect(screen.getByRole('button', { name: 'Save manifest' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('unbound')).toBeDefined();
  });

  it('distinguishes a warning from an error', () => {
    renderInspector({ draft: { ...usable(), graph: null } });
    const problems = within(screen.getByRole('list', { name: 'Draft problems' }));
    expect(problems.getAllByText('warning').length).toBeGreaterThan(0);
    expect(problems.queryByText('error')).toBeNull();
  });

  it('reports a save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderInspector({ onSave });
    await user.click(screen.getByRole('button', { name: 'Save manifest' }));
    expect(onSave).toHaveBeenCalled();
  });
});

describe('the preview', () => {
  it('shows the manifest that will be written', () => {
    // The file is the durable artefact — checked in, hand-edited, diffed — so hiding it would force a
    // save-and-reopen cycle to find out what the form did.
    renderInspector({ draft: promote(usable(), literals[0]!) });
    const preview = screen.getByLabelText('Manifest preview').textContent ?? '';
    const manifest = JSON.parse(preview) as { params: { bind: string; type: string }[] };

    expect(manifest.params[0]).toMatchObject({ bind: '/3/inputs/seed', type: 'seed' });
  });

  it('shows an unbound parameter as a null binding', () => {
    renderInspector({ draft: { ...usable(), graph: null } });
    const manifest = JSON.parse(screen.getByLabelText('Manifest preview').textContent ?? '') as {
      status?: string;
    };
    expect(manifest.status).toBe('unbound');
  });
});

describe('declaring what the generator consumes', () => {
  /** A draft with a text parameter promoted from the graph, which is what implies a text input. */
  const withScript = (): ManifestDraft => {
    const promoted = promote(usable(), literals[2]!);
    const param = promoted.params[0]!;
    return editParam(promoted, param.id, { key: 'script', type: 'text' });
  };

  it('says nothing is declared, and why that matters', () => {
    // §5.2 derives the surfaces an action appears on from this, so an empty list is worth explaining
    // rather than leaving as blank space.
    renderInspector();
    expect(screen.getByText(/nothing declared/)).toBeDefined();
  });

  it('offers to derive the inputs from the parameters', () => {
    renderInspector({ draft: withScript() });
    expect(screen.getByRole('button', { name: /Add 1 from parameters/ })).toBeDefined();
  });

  it('does not offer to derive anything from a draft with no parameters', () => {
    // Nothing to suggest is not a button that does nothing.
    renderInspector();
    expect(screen.queryByRole('button', { name: /from parameters/ })).toBeNull();
  });

  it('declares the input when the offer is taken, with the parameter´s key as its role', () => {
    const onChange = vi.fn();
    renderInspector({ draft: withScript(), onChange });

    void userEvent.click(screen.getByRole('button', { name: /Add 1 from parameters/ }));

    return vi.waitFor(() => {
      const next = onChange.mock.calls.at(-1)?.[0] as ManifestDraft;
      expect(next.consumes).toEqual([
        { type: 'text', role: 'script', required: false, sources: ['inline', 'notes_file', 'text_clip'] },
      ]);
    });
  });

  it('stops offering what is already declared', () => {
    renderInspector({
      draft: { ...withScript(), consumes: [{ type: 'text', role: 'script' }] },
    });
    expect(screen.queryByRole('button', { name: /from parameters/ })).toBeNull();
  });

  it('offers the three sources for a text input and nothing for the others', () => {
    const { rerender } = renderInspector({
      draft: { ...withScript(), consumes: [{ type: 'text', role: 'script', sources: ['inline'] }] },
    });
    expect(screen.getByRole('checkbox', { name: 'notes_file' })).toBeDefined();

    rerender(
      <ManifestInspector
        draft={{ ...withScript(), consumes: [{ type: 'audio', role: 'voice' }] }}
        literals={literals}
      />,
    );
    expect(screen.queryByRole('checkbox', { name: 'notes_file' })).toBeNull();
  });

  it('adds a source when its box is ticked, keeping the declared order', () => {
    const onChange = vi.fn();
    renderInspector({
      draft: { ...withScript(), consumes: [{ type: 'text', role: 'script', sources: ['inline'] }] },
      onChange,
    });

    void userEvent.click(screen.getByRole('checkbox', { name: 'text_clip' }));

    return vi.waitFor(() => {
      const next = onChange.mock.calls.at(-1)?.[0] as ManifestDraft;
      expect(next.consumes[0]?.sources).toEqual(['inline', 'text_clip']);
    });
  });

  it('names an input no parameter can fill, since the panel cannot ask for it', () => {
    renderInspector({
      draft: { ...withScript(), consumes: [{ type: 'audio', role: 'voice_reference' }] },
    });
    expect(screen.getByText(/voice_reference: no parameter of that key/)).toBeDefined();
  });
});

describe('the fields that decide how a parameter behaves', () => {
  const withFps = (): ManifestDraft => {
    const promoted = promote(usable(), literals[1]!);
    const param = promoted.params[0]!;
    return editParam(promoted, param.id, { key: 'fps', type: 'int' });
  };

  it('says a parameter binds nowhere else, so the mechanism is discoverable', () => {
    renderInspector({ draft: withFps() });
    expect(screen.getAllByText('binds nowhere else').length).toBeGreaterThan(0);
  });

  it('adds a secondary binding, which is what a length expression depends on', () => {
    // The spec's own `also` example: `fps` is a literal *and* part of an expression, and binding only
    // the first leaves the expression stale and delivers a clip of the wrong duration.
    const onEditParam = vi.fn();
    renderInspector({ draft: withFps(), onEditParam });

    void userEvent.click(screen.getByRole('button', { name: 'Also bind' }));

    return vi.waitFor(() => {
      const [, changes] = onEditParam.mock.calls.at(-1) ?? [];
      expect(changes?.also).toEqual([{ pointer: '', template: '' }]);
    });
  });

  it('removes the field entirely when the last binding goes, rather than leaving an empty list', () => {
    const onEditParam = vi.fn();
    const base = withFps();
    const draft = editParam(base, base.params[0]!.id, {
      also: [{ pointer: '/1/inputs/expression', template: 'a * {fps}' }],
    });
    renderInspector({ draft, onEditParam });

    void userEvent.click(screen.getByRole('button', { name: 'Remove binding 1' }));

    return vi.waitFor(() => {
      const [, changes] = onEditParam.mock.calls.at(-1) ?? [];
      // Removed, not an empty array: an empty `also` in the file is a field every reader has to skip.
      expect(changes).toHaveProperty('also', undefined);
    });
  });

  it('offers the numeric parameters as the one carrying a declared length', () => {
    renderInspector({ draft: withFps() });
    const select = screen.getByLabelText('Length from');
    expect(within(select).getByRole('option', { name: 'fps' })).toBeDefined();
  });

  it('says what happens when no length parameter is named', () => {
    // Naming nothing is legitimate — a key convention covers the common names — but silence would
    // leave a manifest whose length parameter is called something else sizing from the fallback.
    renderInspector({ draft: withFps() });
    expect(
      within(screen.getByLabelText('Length from')).getByRole('option', { name: 'by key convention' }),
    ).toBeDefined();
  });

  it('does not offer a length parameter for a discovered manifest', () => {
    // There is nothing to name: only the output reveals the length, and the control would suggest
    // otherwise.
    renderInspector({ draft: { ...withFps(), duration: 'discovered' } });
    expect(screen.queryByLabelText('Length from')).toBeNull();
  });
});

describe('what an enum offers', () => {
  /**
   * The dead end this control was built to remove.
   *
   * `enum` was in the type list and had no field for its choices anywhere on the panel, so choosing it
   * raised "an enum needs options" — and Save is disabled while a draft has errors. A type a user can
   * pick and cannot finish is worse than one that is not offered at all.
   */
  const withEnum = (options?: ManifestDraft['params'][number]['options']): ManifestDraft => {
    const promoted = promote(usable(), literals[1]!);
    const param = promoted.params[0]!;
    return editParam(promoted, param.id, {
      key: 'sampler',
      type: 'enum',
      ...(options !== undefined ? { options } : {}),
    });
  };

  it('is asked for as soon as the type is an enum', () => {
    renderInspector({ draft: withEnum() });
    expect(screen.getByLabelText('Choices')).toBeDefined();
  });

  it('is not asked for on a type that has none', () => {
    // A panel that offers meaningless fields teaches the user to ignore all of them.
    renderInspector();
    expect(screen.queryByLabelText('Choices')).toBeNull();
  });

  it('takes a typed list', async () => {
    /*
     * Through `renderLive`, because the field is controlled by the draft — see its comment.
     */
    const draft = renderLive(withEnum([]));

    await userEvent.type(screen.getByLabelText('Values, comma separated'), 'euler, ddim');

    expect(draft().params[0]?.options).toEqual(['euler', 'ddim']);
    // The comma is still under the cursor. Derived from the parsed list it is swallowed the instant it
    // is typed, and a second value can never be entered — which is what this assertion is for.
    expect((screen.getByLabelText('Values, comma separated') as HTMLInputElement).value).toBe('euler, ddim');
  });

  it('switches to a source the backend answers for', async () => {
    const onEditParam = vi.fn();
    renderInspector({ draft: withEnum(['euler']), onEditParam });

    await userEvent.selectOptions(screen.getByLabelText('Choices'), 'capabilities');

    const [, changes] = onEditParam.mock.calls.at(-1) ?? [];
    expect(changes?.options).toEqual({ from: 'capabilities' });
  });

  it('shows the node and input of a backend source, which is how a wrong list is diagnosed', () => {
    // Three of the five shipped manifests fill a dropdown this way. Before this control they could be
    // opened, and the source could neither be seen nor corrected.
    renderInspector({
      draft: withEnum({ from: 'capabilities', nodeClass: 'KSampler', input: 'sampler_name' }),
    });
    expect((screen.getByLabelText('Node class') as HTMLInputElement).value).toBe('KSampler');
    expect((screen.getByLabelText('Input') as HTMLInputElement).value).toBe('sampler_name');
  });

  it('clears the error it used to be impossible to clear', () => {
    // The whole point, stated as the user's experience rather than as a field's presence.
    const { rerender } = render(
      <ManifestInspector draft={withEnum()} literals={literals} onEditParam={vi.fn()} />,
    );
    expect(screen.getAllByText(/an enum needs options/).length).toBeGreaterThan(0);

    rerender(<ManifestInspector draft={withEnum(['euler'])} literals={literals} onEditParam={vi.fn()} />);
    expect(screen.queryByText(/an enum needs options/)).toBeNull();
  });
});

describe('the fields a manifest needs and this panel never offered', () => {
  /**
   * §5.9 says a new generative capability is a JSON file authored from inside the application. It was
   * — in the sense that a file appeared. A parameter had four of the format's ten fields, so what came
   * out had no labels, no defaults, single-line prompt boxes, and no `transport`, without which an
   * image parameter cannot upload its image.
   *
   * Each case below drives the control and reads the manifest the panel would write, rather than
   * asserting a field exists: a control wired to nothing looks identical from the outside.
   */
  const typed = (type: string): ManifestDraft => {
    const promoted = promote(usable(), literals[1]!);
    return editParam(promoted, promoted.params[0]!.id, { key: 'p', type: type as never });
  };

  it('names a parameter, so the generate panel does not show a raw key', () => {
    const draft = typed('int');
    render(<ManifestInspector draft={draft} literals={literals} onEditParam={vi.fn()} />);
    // The placeholder is the key, so the panel says what it will fall back to.
    expect((screen.getByLabelText('Label') as HTMLInputElement).placeholder).toBe('p');
  });

  it('gives an image parameter a transport, which is how the file reaches the backend', async () => {
    const onEditParam = vi.fn();
    render(<ManifestInspector draft={typed('image')} literals={literals} onEditParam={onEditParam} />);

    await userEvent.type(screen.getByLabelText('Transport'), 'u');

    expect(onEditParam.mock.calls.at(-1)?.[1]).toEqual({ transport: 'u' });
  });

  it('does not offer a transport where a file is never uploaded', () => {
    render(<ManifestInspector draft={typed('int')} literals={literals} onEditParam={vi.fn()} />);
    expect(screen.queryByLabelText('Transport')).toBeNull();
  });

  it('takes a numeric default as a number rather than as its text', async () => {
    // Stored as text the manifest fails its own schema, and the graph is patched with a string where
    // the node wants an integer.
    const draft = renderLive(typed('int'));

    // Cleared first: promoting a literal already carries its value as the default, so typing alone
    // would append to it.
    await userEvent.clear(screen.getByLabelText('Default'));
    await userEvent.type(screen.getByLabelText('Default'), '25');

    expect(draft().params[0]?.default).toBe(25);
  });

  it('offers a boolean its two values and the absence of one', () => {
    render(<ManifestInspector draft={typed('bool')} literals={literals} onEditParam={vi.fn()} />);
    const values = [...(screen.getByLabelText('Default') as HTMLSelectElement).options].map(
      (option) => option.value,
    );
    // "no default" is a state the format distinguishes from `false`: absent lets the graph's own value
    // stand.
    expect(values).toEqual(['', 'true', 'false']);
  });

  it('offers a prompt the line-wrapping flag, and a number never', () => {
    render(<ManifestInspector draft={typed('text')} literals={literals} onEditParam={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Multiline' })).toBeDefined();
    cleanup();
    render(<ManifestInspector draft={typed('int')} literals={literals} onEditParam={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: 'Multiline' })).toBeNull();
  });

  it('marks a parameter required, and clears it rather than writing false', () => {
    // Absent and `false` mean the same thing in the format, and writing the second puts a field in
    // every manifest that every reader has to skip.
    const onEditParam = vi.fn();
    render(<ManifestInspector draft={typed('seed')} literals={literals} onEditParam={onEditParam} />);

    void userEvent.click(screen.getByRole('checkbox', { name: 'Required' }));

    return vi.waitFor(() => {
      expect(onEditParam.mock.calls.at(-1)?.[1]).toEqual({ required: true });
    });
  });

  it('offers only the derived defaults the application can actually work out', () => {
    render(<ManifestInspector draft={typed('int')} literals={literals} onEditParam={vi.fn()} />);
    const values = [...(screen.getByLabelText('Or derived from') as HTMLSelectElement).options].map(
      (option) => option.value,
    );
    // A source the application does not know is a default that never resolves.
    expect(values).toEqual(['', ...DERIVED_DEFAULTS]);
  });

  it('reaches the manifest the panel would write', async () => {
    /*
     * The claim the whole panel makes, checked once end to end: what is typed comes out of
     * `draftManifestJson`, which is what lands on disk. Wired to live state, because the fields are
     * controlled by the draft and a mocked handler never advances it.
     */
    const draft = renderLive(typed('text'));

    // Promoting a literal names the parameter after the graph input it came from, so the field starts
    // filled rather than empty.
    await userEvent.clear(screen.getByLabelText('Label'));
    await userEvent.type(screen.getByLabelText('Label'), 'Prompt');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Multiline' }));

    const written = draftManifestJson(draft()) as {
      params: readonly { label?: string; multiline?: boolean }[];
    };
    expect(written.params[0]?.label).toBe('Prompt');
    expect(written.params[0]?.multiline).toBe(true);
  });
});
