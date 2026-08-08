/**
 * Graph introspection.
 *
 * The spec's §5.9: manifests are **not written by hand**. The inspector loads a graph, lists its nodes and
 * their literal inputs, the user ticks what should become a parameter, and the manifest is written out.
 *
 * The contract lives here rather than in a backend so the inspector UI depends only on this package. What
 * a "literal input" is happens to be a ComfyUI notion today; expressing it as an interface is what lets a
 * second backend supply the same list without the inspector learning anything about it.
 */

/** One editable input discovered in a graph. */
export interface GraphLiteral {
  /** Where a manifest would bind, e.g. `/52:3/inputs/seed`. */
  readonly pointer: string;
  readonly nodeId: string;
  /** e.g. `KSampler`. `unknown` when the graph does not say. */
  readonly nodeClass: string;
  readonly input: string;
  readonly value: string | number | boolean;
}

/**
 * A backend's ability to describe a graph.
 *
 * Separate from `GeneratorBackend`: introspection is an authoring-time capability, and a backend that can
 * only run graphs should not be forced to fake it.
 */
export interface GraphIntrospector {
  /** Every input a manifest could bind to. Connections are excluded — they would be overwritten. */
  collectLiterals(graph: unknown): readonly GraphLiteral[];
  /** Node ids present in the graph, for validating `outputs[].node`. */
  nodeIds?(graph: unknown): readonly string[];
}
