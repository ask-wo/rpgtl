import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Catalog, Text } from "./catalog.ts";
import { Findings } from "./checks.ts";

/**
 * A change to a game's catalog, as the page follows it: the whole catalog first and whenever its
 * entries changed, otherwise the texts a write changed with the rest of the catalog. Each carries
 * all the checks find in the catalog.
 */
export const CatalogChange = Schema.Union([
  Schema.TaggedStruct("whole", { catalog: Catalog, findings: Findings }),
  Schema.TaggedStruct("texts", {
    catalog: Catalog.mapFields(Struct.omit(["entries", "texts"])),
    texts: Schema.Array(Text),
    findings: Findings,
  }),
]);
export type CatalogChange = typeof CatalogChange.Type;
