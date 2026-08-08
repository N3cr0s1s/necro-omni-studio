/**
 * The asset types the framework knows.
 *
 * The *closed* part of an otherwise open system. Every generative capability, effect and importer
 * ultimately deals in these five types, while which model, graph or effect produces them stays
 * manifest-driven and open. Adding a sixth type is a deliberate cross-cutting change; adding a generator
 * is a JSON file.
 *
 * Lives in core rather than in the media package because it is shared domain vocabulary: the document
 * model, the generator framework and the media layer all speak it, and none of them owns it.
 */
export const ASSET_TYPES = ['video', 'audio', 'image', 'mask', 'text'] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

export function isAssetType(value: string): value is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(value);
}
