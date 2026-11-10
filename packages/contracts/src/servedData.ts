import * as Schema from "effect/Schema";
import { ImageTextHint } from "./imageText.ts";

/*
 * The fields RPGTL adds to the data files it serves, which the game scripts in `packages/game`
 * read. The game and its plugins don't know them.
 */

const Translations = Schema.Record(Schema.String, Schema.String);

/**
 * Translated event, switch and variable names, by id, which the map view and the F8 panel show.
 * The game and its plugins keep reading the originals, since plugins may look events up by name.
 */
export const ServedNames = Schema.Struct({
  events: Schema.optionalKey(Translations),
  switches: Schema.optionalKey(Translations),
  variables: Schema.optionalKey(Translations),
});
export type ServedNames = typeof ServedNames.Type;

/** Where messages that sit in a picture frame put their text, so the runtime can measure it. */
export const MessageLayout = Schema.Struct({
  top: Schema.Finite,
  indent: Schema.String,
  widest: Schema.Array(Schema.String),
  rows: Schema.Finite,
});
export type MessageLayout = typeof MessageLayout.Type;

/** An image in the same folder to load in place of the one the game asks for. */
export const ImageReplacement = Schema.Struct({ file: Schema.String });
export type ImageReplacement = typeof ImageReplacement.Type;

/** What a served System.json holds besides its text. */
export const ServedSystem = Schema.Struct({
  /** Images to load in place of missing ones, by the path the game asks for. */
  rpgtlImages: Schema.optionalKey(Schema.Record(Schema.String, ImageReplacement)),
  /** Images to erase and draw the English into as they load, by image path. */
  rpgtlImageText: Schema.optionalKey(Schema.Record(Schema.String, ImageTextHint)),
  /** By the translation with its indent, as the same words may stand in different frames. */
  rpgtlMessageLayouts: Schema.optionalKey(Schema.Record(Schema.String, MessageLayout)),
  /**
   * Translations of text that a save stored before it was translated: script text in variables,
   * and actor names, nicknames and profiles. By the source text.
   */
  rpgtlSaveText: Schema.optionalKey(Translations),
  /**
   * The short form of dotted actor names (Fujiwara Yuichiro → Yuichiro), for HUDs whose frames only
   * fit the original name. By the translated name.
   */
  rpgtlShortNames: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ source: Schema.String, short: Schema.String })),
  ),
  /**
   * The original of each class name, by its translation, so status screens can draw a translation
   * no wider than the original their art leaves room for.
   */
  rpgtlClassNames: Schema.optionalKey(Translations),
  /** The title commands are translated, so the runtime draws them over title command pictures. */
  rpgtlCommandsTranslated: Schema.optionalKey(Schema.Literal(true)),
  rpgtlNames: Schema.optionalKey(ServedNames),
});
export type ServedSystem = typeof ServedSystem.Type;

/** What a served map file holds besides its text. */
export const ServedMap = Schema.Struct({ rpgtlNames: Schema.optionalKey(ServedNames) });
export type ServedMap = typeof ServedMap.Type;
