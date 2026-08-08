import { useEffect, useRef } from 'react';
import type { GeneratorRegistry, QueueSnapshot } from '@nos/generators';
import { serializeProvenance } from '@nos/generators';
import type { DesktopBridge } from '../main/ipc-contract.js';

/**
 * Records what made each generated file, beside the file.
 *
 * Generated output lands named after a job id, which is exactly as much use as no name at all. The
 * clip that used it carried provenance; the *file* did not, so a result you liked became untraceable
 * the moment it was not on the timeline — no way to see which generator made it, when, or with what
 * prompt, and therefore no way to make another like it.
 *
 * Written from the snapshot rather than from the accept path on purpose: **every** output gets a
 * record, including the variants a user looked at and discarded. Those files stay on disk — the
 * spec's rule that nothing is destroyed — so leaving them unlabelled would leave the folder full of
 * exactly the anonymous files this exists to prevent.
 *
 * Records are written once per run. The snapshot is republished on every progress tick, and rewriting
 * an unchanged record on each one would keep the folder watcher busy for no reason.
 */
export function useProvenanceWriter(
  snapshot: QueueSnapshot,
  registry: GeneratorRegistry | undefined,
  bridge: () => DesktopBridge | undefined,
): void {
  const written = useRef(new Set<string>());

  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;

    for (const run of snapshot.runs) {
      if (run.status !== 'complete' || run.outputs.length === 0) continue;

      const group = snapshot.groups.find((candidate) => candidate.id === run.group);
      if (group === undefined) continue;
      const manifest = registry?.manifestFor(group.generator);

      run.outputs.forEach((output, index) => {
        if (written.current.has(output.path)) return;
        written.current.add(output.path);

        // A batched run submits several seeds at once and comes back with one output each, in order.
        // Recording the run's first seed against all of them would make every variant of a batch
        // claim the same seed — and a seed that does not reproduce its file is worse than none.
        const seed = run.seeds.length === run.outputs.length ? (run.seeds[index] ?? run.seed) : run.seed;

        const record = {
          asset: output.path,
          generator: group.generator,
          // The manifest's display name as it is *now*: a record that only held an id would read as
          // `minimax_h3_t2v` months later, and as nothing at all once that manifest was removed.
          generatorName: manifest?.name ?? String(group.generator),
          backend: manifest?.backend ?? 'unknown',
          ...(group.preset !== undefined ? { preset: group.preset } : {}),
          run: run.id,
          seed,
          // The run's own finish time, not now: a project opened later must not restamp its files.
          createdAt: new Date(run.finishedAt ?? group.createdAt).toISOString(),
          params: group.params,
        };

        void api.writeProvenance(output.path, serializeProvenance(record)).catch(() => {
          // A record that could not be written must not take the generation down with it: the file
          // itself is there and usable. Allowed to be retried, since the path is forgotten again.
          written.current.delete(output.path);
        });
      });
    }
  }, [snapshot, registry, bridge]);
}
