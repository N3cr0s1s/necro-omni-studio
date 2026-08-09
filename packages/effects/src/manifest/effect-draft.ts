import type { AnyEffectManifest, EffectParam, EffectParamType } from './effect-manifest.js';
import { PARAM_TYPES, isNumericParam } from './effect-manifest.js';

/**
 * Authoring an effect: the shader and the manifest that describes it, as one editable thing.
 *
 * Issue #28. §6.3 defines an effect as a GLSL fragment shader plus a manifest, and §4 reserves
 * `effects/` for both — so the format was always there and the only way in was a text editor and a
 * reload. This is the model behind the editor: everything that can be decided without a GPU.
 *
 * ## Two files, one draft
 *
 * An effect is `<id>.json` and the `.frag` it names, and they are edited together because they only
 * make sense together — a parameter is a manifest entry *and* a uniform the shader reads, and a
 * declaration in one without the other is the whole category of bug this editor exists to prevent.
 * The draft holds both and `effectFiles` names both, so nothing has to remember the pairing.
 *
 * ## What is validated here and what is not
 *
 * Here: everything about the *contract* — an id that can be a filename, a parameter whose uniform is a
 * legal GLSL identifier, a range that is the right way round, a declared parameter the shader never
 * reads. Not here: whether the GLSL compiles. That needs a driver, it belongs to the preview, and
 * pretending otherwise would mean a second, worse GLSL parser living in this package.
 */

/** A parameter being authored. Wider than `EffectParam`: every field is editable and may be blank. */
export interface EffectParamDraft {
  /** Stable identity for the editor, never written to the file. */
  readonly id: string;
  readonly key: string;
  readonly uniform: string;
  readonly type: EffectParamType;
  readonly label?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly default?: number | boolean | readonly number[];
}

export interface EffectDraft {
  readonly id: string;
  readonly name: string;
  /** `effect` or `transition`; the two differ in what the compositor gives the shader. */
  readonly category: 'effect' | 'transition';
  readonly group?: string;
  readonly description?: string;
  /**
   * Textures the shader reads, in the order the compositor binds them.
   *
   * An effect declares `source`; a transition declares the two it blends between. Held as written
   * rather than derived from the category, because a mask-aware effect declares a second one and the
   * spec is explicit that a mask is not a special case.
   */
  readonly samplers: readonly string[];
  readonly params: readonly EffectParamDraft[];
  /** The GLSL, exactly as it will be written to the `.frag`. */
  readonly shader: string;
}

/** The two files an effect is, named from its id. One place, so a check and a write cannot drift. */
export interface EffectFiles {
  readonly manifest: string;
  readonly shader: string;
}

export function effectFiles(id: string): EffectFiles {
  return { manifest: `${id}.json`, shader: `${id}.frag` };
}

/**
 * The shader a new effect starts from.
 *
 * A working pass-through rather than an empty box: an editor that opens on nothing gives a compile
 * error before the user has typed anything, which teaches them the tool is broken. This compiles,
 * renders the frame unchanged, and shows the three names a shader here has — the sampler, the
 * coordinate and the output — which is most of what someone needs to start.
 */
export const STARTER_SHADER = `// Every effect is one fragment pass. The compositor binds:
//   source    the frame so far
//   v_uv      this pixel, 0..1
//   fragColor what you write out
void main() {
  vec4 colour = texture(source, v_uv);
  fragColor = colour;
}
`;

export function emptyEffectDraft(overrides: Partial<EffectDraft> = {}): EffectDraft {
  return {
    id: '',
    name: '',
    category: 'effect',
    samplers: ['source'],
    params: [],
    shader: STARTER_SHADER,
    ...overrides,
  };
}

/** Reopens an authored effect. The shader comes from the file the manifest named. */
export function draftFromEffect(manifest: AnyEffectManifest, shader: string): EffectDraft {
  return {
    id: manifest.id as string,
    name: manifest.name,
    category: manifest.category,
    ...(manifest.group !== undefined ? { group: manifest.group } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    samplers: manifest.samplers,
    params: manifest.params.map((param, index) => ({
      id: `${param.key}_${index}`,
      key: param.key,
      // Shown as written. An empty uniform means "same as the key", which the schema fills in — and
      // showing the filled-in value would make the field look edited when it was not.
      uniform: param.uniform === param.key ? '' : param.uniform,
      type: param.type,
      ...(param.label !== undefined ? { label: param.label } : {}),
      ...(param.min !== undefined ? { min: param.min } : {}),
      ...(param.max !== undefined ? { max: param.max } : {}),
      ...(param.step !== undefined ? { step: param.step } : {}),
      ...(param.default !== undefined ? { default: param.default } : {}),
    })),
    shader,
  };
}

/** The uniform a parameter binds to: what was typed, or the key when nothing was. */
export function uniformOf(param: EffectParamDraft): string {
  return param.uniform.trim() === '' ? param.key.trim() : param.uniform.trim();
}

/**
 * The manifest as it will be written.
 *
 * `keyframable` is deliberately absent: the schema derives it from the type, and writing it out would
 * put a field in every file that can disagree with the rule it restates.
 */
export function effectManifestJson(draft: EffectDraft): Readonly<Record<string, unknown>> {
  return {
    id: draft.id,
    name: draft.name,
    category: draft.category,
    ...(draft.group !== undefined && draft.group !== '' ? { group: draft.group } : {}),
    ...(draft.description !== undefined && draft.description !== ''
      ? { description: draft.description }
      : {}),
    shader: effectFiles(draft.id).shader,
    samplers: draft.samplers,
    params: draft.params.map((param) => toEffectParam(param)),
  };
}

function toEffectParam(param: EffectParamDraft): Readonly<Record<string, unknown>> {
  return {
    key: param.key,
    // Written only when it differs, which keeps the common case — a uniform named after its key — out
    // of the file entirely.
    ...(uniformOf(param) === param.key ? {} : { uniform: uniformOf(param) }),
    type: param.type,
    ...(param.label !== undefined && param.label !== '' ? { label: param.label } : {}),
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.step !== undefined ? { step: param.step } : {}),
    ...(param.default !== undefined ? { default: param.default } : {}),
  };
}

export interface EffectIssue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

/** A legal GLSL identifier, which is also what an id has to be to serve as a filename. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What is wrong with a draft.
 *
 * Errors block saving; warnings do not. The line between them is whether the file would be *wrong* or
 * merely unfinished — an effect with no parameters is a perfectly good effect, and one whose shader
 * never reads a parameter it declares is a bug the author wants to hear about but may be one keystroke
 * away from fixing.
 */
export function validateEffectDraft(draft: EffectDraft): readonly EffectIssue[] {
  const issues: EffectIssue[] = [];
  const error = (path: string, message: string): void =>
    void issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string): void =>
    void issues.push({ severity: 'warning', path, message });

  if (draft.id.trim() === '') error('/id', 'an id is required');
  else if (!IDENTIFIER.test(draft.id)) {
    // The id becomes two filenames and appears in `EffectInstance.effect`, so anything that would need
    // escaping in either is refused at the point it is typed rather than at the point it breaks.
    error('/id', 'an id may use letters, digits and underscores, and may not start with a digit');
  }

  if (draft.name.trim() === '') error('/name', 'a name is required');
  if (draft.samplers.length === 0) error('/samplers', 'a shader with no sampler has nothing to read');

  const keys = new Set<string>();
  const uniforms = new Set<string>();

  draft.params.forEach((param, index) => {
    const path = `/params/${index}`;

    if (param.key.trim() === '') error(`${path}/key`, 'a key is required');
    else if (keys.has(param.key)) error(`${path}/key`, `duplicate key "${param.key}"`);
    keys.add(param.key);

    const uniform = uniformOf(param);
    if (uniform !== '' && !IDENTIFIER.test(uniform)) {
      error(`${path}/uniform`, `"${uniform}" is not a GLSL identifier`);
    } else if (uniforms.has(uniform)) {
      // Two parameters on one uniform is a value that silently wins over the other, which looks like a
      // control that does nothing.
      error(`${path}/uniform`, `two parameters both bind "${uniform}"`);
    }
    uniforms.add(uniform);

    if (param.min !== undefined && param.max !== undefined && param.min > param.max) {
      error(`${path}/min`, 'the minimum is above the maximum');
    }

    // Declared and never read: the control appears, the user moves it, and nothing happens. A warning
    // rather than an error because the next keystroke in the shader may be the one that uses it.
    if (uniform !== '' && !readsIdentifier(draft.shader, uniform)) {
      warn(`${path}/uniform`, `the shader never reads "${uniform}"`);
    }
  });

  for (const sampler of draft.samplers) {
    if (!IDENTIFIER.test(sampler)) {
      error('/samplers', `"${sampler}" is not a GLSL identifier`);
    } else if (!readsIdentifier(draft.shader, sampler)) {
      warn('/samplers', `the shader never reads "${sampler}"`);
    }
  }

  if (!/\bvoid\s+main\s*\(/.test(draft.shader)) {
    error('/shader', 'a fragment shader needs a main()');
  }
  if (!readsIdentifier(draft.shader, 'fragColor')) {
    // Compiles and renders nothing. The compile error for this is about an unused output, which is not
    // what the author needs to be told.
    error('/shader', 'nothing is written to fragColor, so the pass would render nothing');
  }

  return issues;
}

export function effectDraftHasErrors(draft: EffectDraft): boolean {
  return validateEffectDraft(draft).some((issue) => issue.severity === 'error');
}

/**
 * Whether the shader mentions an identifier, ignoring comments.
 *
 * Comment-stripped because the starter shader documents `source` and `fragColor` in its header, and a
 * check fooled by that would call every unfinished effect complete. Word-bounded, so `blur` does not
 * match `blur_radius` — a partial match here reports a parameter as read when it is not.
 */
function readsIdentifier(shader: string, identifier: string): boolean {
  const code = shader.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return new RegExp(`\\b${identifier}\\b`).test(code);
}

/** Parameter types offered by the editor, with `keyframable` shown so the choice is informed. */
export const EFFECT_PARAM_TYPES: readonly {
  readonly type: EffectParamType;
  readonly keyframable: boolean;
}[] = PARAM_TYPES.map((type) => ({ type, keyframable: isNumericParam(type) }));

/** A parameter as the manifest schema will read it, for a caller that wants to preview the result. */
export function asEffectParam(param: EffectParamDraft): EffectParam {
  return {
    key: param.key,
    uniform: uniformOf(param),
    type: param.type,
    ...(param.label !== undefined ? { label: param.label } : {}),
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.step !== undefined ? { step: param.step } : {}),
    ...(param.default !== undefined ? { default: param.default } : {}),
    keyframable: isNumericParam(param.type),
  };
}
