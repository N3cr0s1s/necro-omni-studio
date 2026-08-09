import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../document/document.js';
import { describeLoadError, loadDocument, saveDocument } from './project-file.js';
import { emptyDocument, richDocument } from './rich-document.js';
import { serializeDocument } from './serialize.js';

describe('round trip', () => {
  it('preserves an empty document exactly', () => {
    const original = emptyDocument();
    const result = loadDocument(saveDocument(original));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.document).toEqual(original);
  });

  it('preserves a document using every field, so omitted defaults match schema defaults', () => {
    // This is the test that holds the two halves of the format honest: the serializer
    // omits anything equal to a default, and the schema must restore exactly that value.
    const original = richDocument();
    const result = loadDocument(saveDocument(original));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.document).toEqual(original);
  });

  it('is stable: saving a loaded document reproduces identical text', () => {
    const first = saveDocument(richDocument());
    const loaded = loadDocument(first);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(saveDocument(loaded.value.document)).toBe(first);
  });

  it('preserves the exact frame rate rather than a rounded float', () => {
    const text = saveDocument(emptyDocument());
    expect(text).toContain('"frameRate": "30000/1001"');
    const result = loadDocument(text);
    if (result.ok) {
      expect(result.value.document.frameRate.value).toEqual({
        numerator: 30000,
        denominator: 1001,
      });
    }
  });

  it('preserves a source rate that differs from the project rate', () => {
    const result = loadDocument(saveDocument(richDocument()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const track = result.value.document.sequence.tracks[0]!;
      const clip = track.clips.find((candidate) => candidate.id === 'c2');
      expect(clip?.kind === 'video' && clip.source.sourceRate.value).toEqual({
        numerator: 24,
        denominator: 1,
      });
    }
  });
});

describe('file readability', () => {
  it('writes a constant parameter as a bare number', () => {
    const json = serializeDocument(richDocument());
    const text = JSON.stringify(json);
    expect(text).toContain('"scale":1.08');
    expect(text).not.toContain('"kind":"static"');
  });

  it('omits fields equal to their defaults', () => {
    const json = serializeDocument(emptyDocument()) as Record<string, unknown>;
    const sequence = json['sequence'] as Record<string, unknown>;
    const tracks = sequence['tracks'] as readonly Record<string, unknown>[];
    // An untouched track carries only its identity and layout.
    expect(Object.keys(tracks[0]!).sort()).toEqual(['height', 'id', 'kind', 'name']);
    expect('masks' in json).toBe(false);
  });

  it('ends with a trailing newline and uses two-space indentation', () => {
    const text = saveDocument(emptyDocument());
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "id": "p1"');
  });

  it('never emits null for an absent optional field', () => {
    expect(saveDocument(richDocument())).not.toContain('null');
  });
});

describe('load failures', () => {
  it('reports malformed JSON', () => {
    const result = loadDocument('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-json');
      expect(describeLoadError(result.error)).toContain('not valid JSON');
    }
  });

  it('rejects a non-object root', () => {
    for (const text of ['[]', '42', '"a"', 'null']) {
      const result = loadDocument(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toMatch(/not-an-object|invalid-json/);
    }
  });

  it('rejects a file with no schemaVersion', () => {
    const result = loadDocument('{"id":"p1"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('migration');
      expect(describeLoadError(result.error)).toContain('no schemaVersion');
    }
  });

  it('refuses a project from a newer build instead of silently dropping its data', () => {
    const text = JSON.stringify({ ...serializeDocument(emptyDocument()), schemaVersion: 999 });
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = describeLoadError(result.error);
      expect(message).toContain('newer version');
      expect(message).toContain('discard data');
    }
  });

  it('reports every structural problem at once, each with its path', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      id: 'p1',
      frameRate: '30',
      resolution: { width: 0, height: -1 },
      sequence: { id: 's1', tracks: [{ kind: 'video', id: 'v1', height: 'tall' }] },
    });
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'invalid-document') {
      const paths = result.error.issues.map((entry) => entry.path);
      expect(paths).toContain('resolution.width');
      expect(paths).toContain('resolution.height');
      expect(paths).toContain('sequence.tracks[0].height');
      expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects an asset path that escapes the project folder', () => {
    const document = serializeDocument(richDocument()) as Record<string, unknown>;
    const text = JSON.stringify(document).replace('media/interview_a.mp4', '../../etc/passwd');
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'invalid-document') {
      expect(describeLoadError(result.error)).toContain('escape the project folder');
    }
  });

  it('rejects a non-positive speed factor that would divide by zero in the retimer', () => {
    const text = JSON.stringify(serializeDocument(richDocument())).replace('"factor":0.5', '"factor":0');
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'invalid-document') {
      expect(describeLoadError(result.error)).toContain('speed factor must be positive');
    }
  });

  it('rejects an unknown track kind, naming the discriminant', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      id: 'p1',
      frameRate: '30',
      resolution: { width: 1920, height: 1080 },
      sequence: { id: 's1', tracks: [{ kind: 'midi', id: 'x1' }] },
    });
    const result = loadDocument(text);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'invalid-document') {
      expect(result.error.issues[0]!.path).toBe('sequence.tracks[0].kind');
      expect(result.error.issues[0]!.message).toContain('unknown kind "midi"');
    }
  });
});

describe('forward compatibility', () => {
  it('ignores unknown fields, so a project touched by a newer build still opens', () => {
    const document = serializeDocument(emptyDocument()) as Record<string, unknown>;
    const text = JSON.stringify({ ...document, colorPipeline: { lut: 'aces.cube' } });
    const result = loadDocument(text);
    expect(result.ok).toBe(true);
  });

  it('degrades an unrecognized easing to linear rather than refusing the timeline', () => {
    const text = JSON.stringify(serializeDocument(richDocument())).replace(
      '"ease":"ease-in-out"',
      '"ease":"bezier"',
    );
    const result = loadDocument(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const track = result.value.document.sequence.tracks[0]!;
      const clip = track.clips.find((candidate) => candidate.id === 'c1');
      const opacity = clip?.kind === 'video' ? clip.transform.opacity : undefined;
      expect(opacity?.kind === 'animated' && opacity.keyframes[0]!.ease).toBe('linear');
    }
  });

  it('applies defaults for a minimal hand-written project file', () => {
    const text = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      id: 'p1',
      frameRate: '25',
      resolution: { width: 1920, height: 1080 },
      sequence: { id: 's1' },
    });
    const result = loadDocument(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const document = result.value.document;
      expect(document.name).toBe('Untitled');
      expect(document.sequence.tracks).toEqual([]);
      expect(document.masks).toEqual([]);
      expect(document.sequence.markers).toEqual([]);
      expect(document.sequence.workRange).toBeUndefined();
    }
  });
});

describe('migration', () => {
  it('reports no migrations for a current-version file', () => {
    const result = loadDocument(saveDocument(emptyDocument()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.migrationsApplied).toEqual([]);
  });

  it('has no gap in the chain below the current version', () => {
    // Guards the invariant that every version below the current one is reachable. When
    // SCHEMA_VERSION is bumped without registering a step, this fails immediately.
    const text = JSON.stringify({ ...serializeDocument(emptyDocument()), schemaVersion: 0 });
    const result = loadDocument(text);
    if (SCHEMA_VERSION === 1) {
      // v0 was never released, so there is deliberately no path from it.
      expect(result.ok).toBe(false);
    } else {
      expect(result.ok).toBe(true);
    }
  });
});
