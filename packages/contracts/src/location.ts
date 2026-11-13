import * as Schema from "effect/Schema";

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Keys = Schema.Array(Schema.String);

/** A table of the game's database, whose records have text fields or notes. */
export const Table = Schema.Literals([
  "actors",
  "classes",
  "skills",
  "items",
  "weapons",
  "armors",
  "enemies",
  "states",
  "mapInfos",
  "tilesets",
]);
export type Table = typeof Table.Type;

/** An event list: a common event's, or a page's of a troop or a map event. */
export const EventListRef = Schema.TaggedUnion({
  CommonEvent: { event: Index },
  TroopPage: { troop: Index, page: Index },
  MapEventPage: { map: Index, event: Index, page: Index },
});
export type EventListRef = typeof EventListRef.Type;

/** What holds a note: a record, a class's learning, a map or a map event. */
export const NoteOwner = Schema.TaggedUnion({
  Record: { table: Table, record: Index },
  ClassLearning: { record: Index, learning: Index },
  Map: { map: Index },
  MapEvent: { map: Index, event: Index },
});
export type NoteOwner = typeof NoteOwner.Type;

/** Where an entry's text is in the game, whatever engine reads it. */
export const Location = Schema.TaggedUnion({
  /** A Show Text or Scrolling Text message: the command at `index` and the lines after it. */
  Message: { list: EventListRef, index: Index },
  /** Text in a command's parameter, at `keys` inside it, which may go through JSON text. */
  CommandText: { list: EventListRef, index: Index, parameter: Index, keys: Keys },
  /**
   * The `literal`th string a script stores in or compares with a variable; in an XP game, its
   * `literal`th string literal, counted over the Script command and the 655 lines after it.
   */
  ScriptText: { list: EventListRef, index: Index, parameter: Index, literal: Index },
  /**
   * The `literal`th string literal of the `script`th Ruby script of an XP game, which the game
   * names `name`.
   */
  RubyScriptText: { script: Index, name: Schema.String, literal: Index },
  /** A text field of a database record, such as an actor's name or an item's description. */
  RecordField: { table: Table, record: Index, field: Schema.String },
  /** The value of the `tag`th tag of a note. */
  NoteTag: { owner: NoteOwner, tag: Index },
  /** A text of the game's system settings, such as its title or a menu term, at `keys`. */
  SystemText: { keys: Keys },
  /** A map's display name. */
  MapName: { map: Index },
  /** A map event's name, which only the map view shows. */
  EventName: { map: Index, event: Index },
  /** The name of a switch or variable, which only the F8 panel shows. */
  Name: { group: Schema.Literals(["switches", "variables"]), id: Index },
  /** A setting of a plugin, at `keys` inside it, which may go through JSON text. */
  PluginSetting: { plugin: Schema.String, keys: Keys },
  /** Lines of an image's saved read result; `image` is its path without extension. */
  ImageLines: { image: Schema.String, lines: Schema.Array(Index) },
});
export type Location = typeof Location.Type;
