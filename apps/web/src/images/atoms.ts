import * as Stream from "effect/Stream";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { following } from "../app/following.ts";
import { Rpgtl } from "../app/Rpgtl.ts";
import { imageResultsKey } from "../translation/atoms.ts";

/** What the image reader found in the game's images. */
export const imageResults = (id: string) =>
  Rpgtl.query("images", "results", { query: { id }, reactivityKeys: imageResultsKey(id) });

export const setImageOptions = Rpgtl.mutation("catalogs", "setImageOptions");

const browserStorage = Atom.runtime(KeyValueStore.layerStorage(() => localStorage));

/**
 * Whether exports carry what translated images need: a translation file's read results and erased
 * tiles, and an XP patch's tiles. The browser keeps it.
 */
export const imagesInExports = Atom.kvs({
  runtime: browserStorage,
  key: "rpgtl-images-in-exports",
  schema: Schema.Boolean,
  defaultValue: () => true,
});
export const clearImageText = Rpgtl.mutation("images", "clear");
export const readImages = Rpgtl.mutation("images", "start");

/** The image reader's setup status, which the server sends on every change. */
export const imageReaderStatus = Rpgtl.runtime.atom(
  following(Stream.unwrap(Rpgtl.use((client) => client.imageReader.status()))),
);

export const setUpImageReader = Rpgtl.mutation("imageReader", "setUp");
export const removeImageReader = Rpgtl.mutation("imageReader", "remove");
export const removeKoreanModel = Rpgtl.mutation("imageReader", "removeKorean");
