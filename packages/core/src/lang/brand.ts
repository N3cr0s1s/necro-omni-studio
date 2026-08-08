/**
 * Nominal typing helper.
 *
 * The document model is a graph of string ids referring to each other. Passing a
 * `TrackId` where a `ClipId` belongs is a class of bug that structural typing cannot
 * catch, so every id gets its own brand. The same applies to frame positions versus
 * frame counts, where the confusion is an off-by-one instead of a wrong entity.
 */
declare const brandTag: unique symbol;

export type Brand<TBase, TBrand extends string> = TBase & {
  readonly [brandTag]: TBrand;
};

/**
 * Reinterprets a raw value as a branded one.
 *
 * Unchecked by construction — the brand asserts an invariant the type system cannot
 * verify, so only validating factories (`frameIndex`, `clipId`, …) and deserializers
 * should call this. Everywhere else the brand should be carried through, not re-minted;
 * a call to this function in ordinary logic is a smell that a type was widened
 * somewhere upstream.
 */
export function unsafeBrand<TBranded extends Brand<unknown, string>>(value: unknown): TBranded {
  return value as TBranded;
}
