// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphLiteral, ManifestDraft } from '@nos/generators';
import { addOutput, editParam, emptyDraft, promote } from '@nos/generators';
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
