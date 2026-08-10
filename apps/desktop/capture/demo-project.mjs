/**
 * The project the README pictures are taken of.
 *
 * Data, and its own module, for two reasons. A screenshot of an empty timeline says nothing about an
 * editor, so this has to look like *work* — four shots, a dissolve, a graded shot, a title that
 * animates, an audio bed with ramps at both ends, and markers where a person would actually put them.
 * And a document written by hand is a document that can be wrong: separated from the script that
 * launches the shell, it can be handed straight to `loadDocument` and checked in a millisecond rather
 * than by watching a window fail to open.
 *
 * The media it names is synthesized by the capture script, so nothing is committed here but the shape.
 */

const videoClip = (id, asset, start, duration, extra = {}) => ({
  id,
  kind: 'video',
  span: { start, duration },
  label: asset.replace('media/', '').replace('.mp4', ''),
  enabled: true,
  effects: [],
  source: { asset, sourceIn: 0, sourceRate: '30' },
  ...extra,
});

export function demoProject() {
  return {
    schemaVersion: 1,
    id: 'demo',
    name: 'Demo',
    frameRate: '30',
    resolution: { width: 1920, height: 1080 },
    sequence: {
      id: 'main',
      markers: [
        { frame: 80, label: 'dissolve', color: '#e0b341' },
        { frame: 160, label: 'grade from here', color: '#4c9aff' },
        { frame: 270, label: 'last shot' },
      ],
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          name: 'V1',
          height: 84,
          clips: [
            videoClip('shot_1', 'media/wide.mp4', 0, 90),
            // Overlapping the shot before it, which is what a dissolve is here: the incoming clip
            // carries the ramp across the overlap.
            videoClip('shot_2', 'media/bars.mp4', 80, 80, { fade: { inFrames: 10, outFrames: 0 } }),
            videoClip('shot_3', 'media/grad.mp4', 160, 110, {
              effects: [{ id: 'grain_1', effect: 'film_grain', enabled: true, params: {} }],
            }),
            videoClip('shot_4', 'media/noise.mp4', 270, 80, { fade: { inFrames: 0, outFrames: 20 } }),
          ],
        },
        {
          id: 'A1',
          kind: 'audio',
          name: 'A1 · bed',
          height: 64,
          clips: [
            {
              id: 'bed_1',
              kind: 'audio',
              span: { start: 0, duration: 350 },
              label: 'bed',
              enabled: true,
              effects: [],
              source: { asset: 'media/bed.wav', sourceIn: 0, sourceRate: '30' },
              fade: { inFrames: 15, outFrames: 30 },
            },
          ],
        },
        {
          id: 'T1',
          kind: 'text',
          name: 'T1 · text',
          height: 46,
          clips: [
            {
              id: 'title_1',
              kind: 'text',
              span: { start: 8, duration: 70 },
              label: 'NECRO OMNI STUDIO',
              enabled: true,
              effects: [],
              content: {
                text: 'NECRO OMNI STUDIO',
                font: 'system-ui, sans-serif',
                size: 120,
                weight: 700,
                align: 'center',
              },
              /*
               * A bare number is a constant on disk and `{ keyframes: [...] }` is an animation — the
               * file format's own rule, so that a hand-inspected `project.json` stays readable. Writing
               * `{ kind: 'static', value: 0 }` here is what the *in-memory* type looks like, and it is
               * rejected by the loader with four lines naming exactly which fields are wrong.
               */
              transform: {
                x: 0,
                y: 0,
                scale: 1,
                rotation: 0,
                // Keyframed, so the parameter lanes have something to draw.
                opacity: {
                  keyframes: [
                    { id: 'o0', frame: 0, value: 0, ease: 'ease-out' },
                    { id: 'o1', frame: 18, value: 1, ease: 'linear' },
                    { id: 'o2', frame: 55, value: 1, ease: 'ease-in' },
                    { id: 'o3', frame: 70, value: 0, ease: 'linear' },
                  ],
                },
              },
            },
          ],
        },
      ],
    },
  };
}
