import * as Data from "effect/Data";
import * as Option from "effect/Option";

/** An event list: a common event's, or a page's of a troop or a map event. */
export type EventListRef = Data.TaggedEnum<{
  CommonEvent: { readonly event: number };
  TroopPage: { readonly troop: number; readonly page: number };
  MapEventPage: { readonly event: number; readonly page: number };
}>;
export const EventListRef = Data.taggedEnum<EventListRef>();

/** What holds a note: a record, a class's learning, a map or a map event. */
export type NoteOwner = Data.TaggedEnum<{
  Record: { readonly record: number };
  ClassLearning: { readonly record: number; readonly learning: number };
  Map: {};
  MapEvent: { readonly event: number };
}>;
export const NoteOwner = Data.taggedEnum<NoteOwner>();

export type NameGroup = "events" | "switches" | "variables";

/**
 * Where an entry's text is. Saved catalogs keep it as an entry path (see "entry path" in
 * docs/glossary.md); `locationOf` reads one and `pathOf` writes it.
 */
export type Location = Data.TaggedEnum<{
  /** A Show Text or Scrolling Text message: the command at `index` and the lines after it. */
  Message: { readonly list: EventListRef; readonly index: number };
  /** Text in a command's parameter, at `keys` inside it, which may go through JSON text. */
  CommandText: {
    readonly list: EventListRef;
    readonly index: number;
    readonly parameter: number;
    readonly keys: ReadonlyArray<string>;
  };
  /** The `literal`th string a script stores in or compares with a variable. */
  ScriptText: {
    readonly list: EventListRef;
    readonly index: number;
    readonly parameter: number;
    readonly literal: number;
  };
  /** A text field of a database record, such as an actor's name or an item's description. */
  RecordField: { readonly record: number; readonly field: string };
  /** The value of the `tag`th tag of a note. */
  NoteTag: { readonly owner: NoteOwner; readonly tag: number };
  /** A text in System.json, such as the game title or a menu term, at `keys`. */
  SystemText: { readonly keys: ReadonlyArray<string> };
  /** A map's display name. */
  MapName: {};
  /** The name of an event, switch or variable, which only the map view and the F8 panel show. */
  Name: { readonly group: NameGroup; readonly id: number };
  /** A setting of a plugin in js/plugins.js, at `keys` inside it, which may go through JSON text. */
  PluginSetting: { readonly plugin: string; readonly keys: ReadonlyArray<string> };
  /** Lines of an image's saved read result. */
  ImageLines: { readonly lines: ReadonlyArray<number> };
}>;
export const Location = Data.taggedEnum<Location>();

const number = (key: string | undefined) =>
  key !== undefined && /^\d+$/.test(key) ? Option.some(Number(key)) : Option.none();

const listKeys = EventListRef.$match({
  CommonEvent: ({ event }) => [String(event), "list"],
  TroopPage: ({ troop, page }) => [String(troop), "pages", String(page), "list"],
  MapEventPage: ({ event, page }) => ["events", String(event), "pages", String(page), "list"],
});

const noteKeys = NoteOwner.$match({
  Record: ({ record }) => [String(record)],
  ClassLearning: ({ record, learning }) => [String(record), "learnings", String(learning)],
  Map: () => [],
  MapEvent: ({ event }) => ["events", String(event)],
});

/** The entry path of a location. */
export const pathOf: (location: Location) => ReadonlyArray<string> = Location.$match({
  Message: ({ list, index }) => [...listKeys(list), String(index), "parameters", "0"],
  CommandText: ({ list, index, parameter, keys }) => [
    ...listKeys(list),
    String(index),
    "parameters",
    String(parameter),
    ...keys,
  ],
  ScriptText: ({ list, index, parameter, literal }) => [
    ...listKeys(list),
    String(index),
    "parameters",
    String(parameter),
    "variableText",
    String(literal),
  ],
  RecordField: ({ record, field }) => [String(record), field],
  NoteTag: ({ owner, tag }) => [...noteKeys(owner), "note", "noteText", String(tag)],
  SystemText: ({ keys }) => keys,
  MapName: () => ["displayName"],
  Name: ({ group, id }) =>
    group === "events" ? ["events", String(id), "name"] : [group, String(id)],
  PluginSetting: ({ plugin, keys }) => [plugin, ...keys],
  ImageLines: ({ lines }) => ["lines", ...lines.map(String)],
});

const isMap = (file: string) => /^Map\d+\.json$/.test(file);

/** The event list that keys up to and including "list" name in `file`. */
function listOf(file: string, keys: ReadonlyArray<string>): Option.Option<EventListRef> {
  if (file === "CommonEvents.json" && keys.length === 2)
    return Option.map(number(keys[0]), (event) => EventListRef.CommonEvent({ event }));
  if (file === "Troops.json" && keys.length === 4 && keys[1] === "pages")
    return Option.zipWith(number(keys[0]), number(keys[2]), (troop, page) =>
      EventListRef.TroopPage({ troop, page }),
    );
  if (isMap(file) && keys.length === 5 && keys[0] === "events" && keys[2] === "pages")
    return Option.zipWith(number(keys[1]), number(keys[3]), (event, page) =>
      EventListRef.MapEventPage({ event, page }),
    );
  return Option.none();
}

function commandLocation(file: string, path: ReadonlyArray<string>, listEnd: number) {
  const [position, parameters, parameter, ...rest] = path.slice(listEnd + 1);
  if (parameters !== "parameters") return Option.none();
  return Option.all({
    list: listOf(file, path.slice(0, listEnd + 1)),
    index: number(position),
    parameter: number(parameter),
  }).pipe(
    Option.flatMap(({ list, index, parameter: at }): Option.Option<Location> => {
      if (rest[0] === "variableText")
        return rest.length === 2
          ? Option.map(number(rest[1]), (literal) =>
              Location.ScriptText({ list, index, parameter: at, literal }),
            )
          : Option.none();
      return Option.some(
        at === 0 && rest.length === 0
          ? Location.Message({ list, index })
          : Location.CommandText({ list, index, parameter: at, keys: rest }),
      );
    }),
  );
}

function noteOwner(file: string, keys: ReadonlyArray<string>): Option.Option<NoteOwner> {
  if (isMap(file)) {
    if (keys.length === 0) return Option.some(NoteOwner.Map());
    return keys.length === 2 && keys[0] === "events"
      ? Option.map(number(keys[1]), (event) => NoteOwner.MapEvent({ event }))
      : Option.none();
  }
  if (keys.length === 1)
    return Option.map(number(keys[0]), (record) => NoteOwner.Record({ record }));
  return keys.length === 3 && keys[1] === "learnings"
    ? Option.zipWith(number(keys[0]), number(keys[2]), (record, learning) =>
        NoteOwner.ClassLearning({ record, learning }),
      )
    : Option.none();
}

/** The location an entry path names in `file`, or none for a path RPGTL never writes. */
export function locationOf(file: string, path: ReadonlyArray<string>): Option.Option<Location> {
  if (file.startsWith("img/")) {
    const [lines, ...numbers] = path;
    return lines === "lines"
      ? Option.map(Option.all(numbers.map(number)), (found) =>
          Location.ImageLines({ lines: found }),
        )
      : Option.none();
  }
  if (file === "plugins.js") {
    const [plugin, ...keys] = path;
    return plugin === undefined
      ? Option.none()
      : Option.some(Location.PluginSetting({ plugin, keys }));
  }
  const note = path.length - 3;
  if (path[note] === "note" && path[note + 1] === "noteText")
    return Option.zipWith(
      noteOwner(file, path.slice(0, note)),
      number(path[note + 2]),
      (owner, tag) => Location.NoteTag({ owner, tag }),
    );
  const list = path.indexOf("list");
  if (list >= 0) return commandLocation(file, path, list);
  const [first, second, third] = path;
  if (file === "System.json") {
    if (path.length === 2 && (first === "switches" || first === "variables"))
      return Option.map(number(second), (id) => Location.Name({ group: first, id }));
    return path.length ? Option.some(Location.SystemText({ keys: path })) : Option.none();
  }
  if (isMap(file)) {
    if (path.length === 1 && first === "displayName") return Option.some(Location.MapName());
    return path.length === 3 && first === "events" && third === "name"
      ? Option.map(number(second), (id) => Location.Name({ group: "events", id }))
      : Option.none();
  }
  return path.length === 2 && second !== undefined
    ? Option.map(number(first), (record) => Location.RecordField({ record, field: second }))
    : Option.none();
}

/** The location of an entry, when it has a path. */
export const entryLocation = (entry: {
  readonly file?: string | undefined;
  readonly path?: ReadonlyArray<string> | undefined;
}) =>
  entry.file === undefined || entry.path === undefined
    ? Option.none()
    : locationOf(entry.file, entry.path);

/** Whether the entry is the text of a Show Text command. */
export const isMessage = (entry: Parameters<typeof entryLocation>[0]) =>
  Option.exists(entryLocation(entry), (at) => at._tag === "Message");
