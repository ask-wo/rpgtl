import { EventListRef, Location, NoteOwner, type Table } from "@rpgtl/contracts";
import * as Data from "effect/Data";

/** An entry or what a run asks about; text that only a run made, such as a speaker's name, has no location. */
export interface Placed {
  readonly location?: Location | undefined;
}

/** Whether the entry is the text of a Show Text command. */
export const isMessage = (entry: Placed) => entry.location?._tag === "Message";

type ImageLines = Extract<Location, { readonly _tag: "ImageLines" }>;

/** Whether the entry is text read in an image. */
export const isImageText = <E extends Placed>(
  entry: E,
): entry is E & { readonly location: ImageLines } => entry.location?._tag === "ImageLines";

/** Text of the game's system settings: its title, terms, and switch and variable names. */
export const isSystemText = ({ location }: Placed) =>
  location?._tag === "SystemText" || location?._tag === "Name";

/** Text of the system's or a plugin's settings, which says nothing about the story's people. */
export const isSettingText = (entry: Placed) =>
  isSystemText(entry) || entry.location?._tag === "PluginSetting";

/** A text that names an event list, the same for equal lists. */
export const listKey = EventListRef.match({
  CommonEvent: ({ event }) => `common ${event}`,
  TroopPage: ({ troop, page }) => `troop ${troop} ${page}`,
  MapEventPage: ({ map, event, page }) => `map ${map} ${event} ${page}`,
});

/** The part of the game a location is in, which groups its text into scenes and the Text page's tree. */
export type Place = Data.TaggedEnum<{
  Map: { readonly map: number };
  Table: { readonly table: Table };
  CommonEvents: {};
  Troops: {};
  System: {};
  Plugins: {};
  Image: { readonly image: string };
  /** One of an XP game's Ruby scripts. */
  Script: { readonly script: number; readonly name: string };
}>;
export const Place = Data.taggedEnum<Place>();

const listPlace = EventListRef.match({
  CommonEvent: () => Place.CommonEvents(),
  TroopPage: () => Place.Troops(),
  MapEventPage: ({ map }) => Place.Map({ map }),
});

const notePlace = NoteOwner.match({
  Record: ({ table }) => Place.Table({ table }),
  ClassLearning: () => Place.Table({ table: "classes" }),
  Map: ({ map }) => Place.Map({ map }),
  MapEvent: ({ map }) => Place.Map({ map }),
});

export const placeOf: (location: Location) => Place = Location.match({
  Message: ({ list }) => listPlace(list),
  CommandText: ({ list }) => listPlace(list),
  ScriptText: ({ list }) => listPlace(list),
  RecordField: ({ table }) => Place.Table({ table }),
  NoteTag: ({ owner }) => notePlace(owner),
  SystemText: () => Place.System(),
  MapName: ({ map }) => Place.Map({ map }),
  EventName: ({ map }) => Place.Map({ map }),
  Name: () => Place.System(),
  PluginSetting: () => Place.Plugins(),
  ImageLines: ({ image }) => Place.Image({ image }),
  RubyScriptText: ({ script, name }) => Place.Script({ script, name }),
});

/** A place as a short text, such as `map3` or `actors`; an image's is its path. */
export const placeKey: (place: Place) => string = Place.$match({
  Map: ({ map }) => `map${map}`,
  Table: ({ table }) => table,
  CommonEvents: () => "commonEvents",
  Troops: () => "troops",
  System: () => "system",
  Plugins: () => "plugins",
  Image: ({ image }) => image,
  Script: ({ script }) => `script${script}`,
});
