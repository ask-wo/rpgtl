import type { EventList, Plugins } from "@rpgtl/contracts";
import * as Arr from "effect/Array";
import * as Optic from "effect/Optic";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as SchemaIssue from "effect/SchemaIssue";
import { decodeJson, noteTags, variableStrings } from "./extract.ts";
import type { GameFile } from "./gameFile.ts";
import { EventListRef, Location, NoteOwner } from "./location.ts";

type Focus<S> = Optic.Optional<S, unknown>;

const missing = (message: string) => Result.fail(new SchemaIssue.InvalidValue({ message }));

/** One key into a value, going through JSON text when the value is a string. */
const step = (key: string): Focus<unknown> =>
  Optic.makeOptional(
    function get(value): Result.Result<unknown, SchemaIssue.Issue> {
      if (Predicate.isString(value))
        return Option.match(decodeJson(value), {
          onNone: () => missing("not JSON text"),
          onSome: get,
        });
      if (Array.isArray(value))
        return Option.match(Arr.get(value, Number(key)), {
          onNone: () => missing(`no item ${key}`),
          onSome: Result.succeed,
        });
      return Predicate.isObject(value) && Object.hasOwn(value, key)
        ? Result.succeed(value[key])
        : missing(`no key ${key}`);
    },
    function set(changed, value): Result.Result<unknown, SchemaIssue.Issue> {
      if (Predicate.isString(value))
        return Option.match(decodeJson(value), {
          onNone: () => missing("not JSON text"),
          onSome: (parsed) => Result.map(set(changed, parsed), (json) => JSON.stringify(json)),
        });
      if (Array.isArray(value)) {
        const index = Number(key);
        return Object.hasOwn(value, index)
          ? Result.succeed(value.map((item: unknown, at) => (at === index ? changed : item)))
          : missing(`no item ${key}`);
      }
      return Predicate.isObject(value) && Object.hasOwn(value, key)
        ? Result.succeed({ ...value, [key]: changed })
        : missing(`no key ${key}`);
    },
  );

const within = <S>(focus: Focus<S>, keys: ReadonlyArray<string>) =>
  keys.reduce((inner, key) => inner.compose(step(key)), focus);

/** Keys into a record: a setting of a plugin or a field of System.json. */
function intoRecord<S>(
  focus: Optic.Optional<S, { readonly [key: string]: unknown }>,
  keys: ReadonlyArray<string>,
) {
  const [first, ...rest] = keys;
  return first === undefined ? Option.none() : Option.some(within(focus.at(first), rest));
}

/** A piece of a string, such as one tag of a note, read and replaced in place. */
const slice = (
  pieces: (text: string) => ReadonlyArray<{ start: number; end: number; value: string }>,
  index: number,
  write: (value: string, current: string) => string,
): Focus<unknown> => {
  const piece = (text: unknown) =>
    Predicate.isString(text) ? Arr.get(pieces(text), index) : Option.none();
  return Optic.makeOptional<unknown, unknown>(
    (text) =>
      Option.match(piece(text), {
        onNone: () => missing(`no piece ${index}`),
        onSome: ({ value }) => Result.succeed(value),
      }),
    (value, text) => {
      const found = piece(text);
      return Option.isSome(found) && Predicate.isString(text) && Predicate.isString(value)
        ? Result.succeed(
            text.slice(0, found.value.start) +
              write(value, found.value.value) +
              text.slice(found.value.end),
          )
        : missing(`no piece ${index}`);
    },
  );
};

// A `<` or `>` would end the tag early. Some plugins read a tag line by line, so a value gets line
// breaks only where the game's own value has them.
const tagValue = (value: string, current: string) =>
  (current.includes("\n") ? value : value.replace(/\s*\n\s*/g, " "))
    .replace(/</g, "‹")
    .replace(/>/g, "›");

/** The text at the focus, as long as it is still `source`. */
const holding = (source: string): Optic.Optional<unknown, string> =>
  Optic.makeOptional(
    (value) => (value === source ? Result.succeed(source) : missing("source changed")),
    (translation, value) =>
      value === source ? Result.succeed(translation) : missing("source changed"),
  );

const file = Optic.id<GameFile>();
const records = {
  Database: file.tag("Database").key("data"),
  Tilesets: file.tag("Tilesets").key("data"),
};
const mapData = file.tag("Map").key("data");
const mapEvent = (event: number) => mapData.key("events").at(event).refine(Predicate.isNotNull);

/** The command list an event list reference names. */
export const listFocus: (ref: EventListRef) => Optic.Optional<GameFile, EventList> =
  EventListRef.$match({
    CommonEvent: ({ event }) =>
      file.tag("CommonEvents").key("data").at(event).refine(Predicate.isNotNull).key("list"),
    TroopPage: ({ troop, page }) =>
      file
        .tag("Troops")
        .key("data")
        .at(troop)
        .refine(Predicate.isNotNull)
        .key("pages")
        .at(page)
        .key("list"),
    MapEventPage: ({ event, page }) => mapEvent(event).key("pages").at(page).key("list"),
  });

const parameter = (list: EventListRef, index: number, at: number) =>
  listFocus(list).at(index).key("parameters").at(at);

const noteFocus = (data: GameFile, owner: NoteOwner): Focus<GameFile> =>
  NoteOwner.$match(owner, {
    Record: ({ record }) =>
      records[data._tag === "Tilesets" ? "Tilesets" : "Database"]
        .at(record)
        .refine(Predicate.isNotNull)
        .at("note"),
    ClassLearning: ({ record, learning }) =>
      within(records.Database.at(record).refine(Predicate.isNotNull).at("learnings"), [
        String(learning),
        "note",
      ]),
    Map: () => mapData.at("note"),
    MapEvent: ({ event }) => mapEvent(event).at("note"),
  });

/**
 * The text a location names in a game file, as long as it is still `source`. Messages and names
 * have none: applyTranslations handles them without replacing text in place.
 */
export const textFocus = (
  data: GameFile,
  location: Location,
  source: string,
): Option.Option<Optic.Optional<GameFile, string>> =>
  Option.map(
    Location.$match(location, {
      CommandText: ({ list, index, parameter: at, keys }) =>
        Option.some(within(parameter(list, index, at), keys)),
      ScriptText: ({ list, index, parameter: at, literal }) =>
        Option.some(
          parameter(list, index, at).compose(
            slice(variableStrings, literal, (value) => JSON.stringify(value)),
          ),
        ),
      NoteTag: ({ owner, tag }) =>
        Option.some(noteFocus(data, owner).compose(slice(noteTags, tag, tagValue))),
      RecordField: ({ record, field }) =>
        Option.some(records.Database.at(record).refine(Predicate.isNotNull).at(field)),
      SystemText: ({ keys }) => intoRecord(file.tag("System").key("data"), keys),
      MapName: () => Option.some(mapData.at("displayName")),
      Message: () => Option.none(),
      Name: () => Option.none(),
      PluginSetting: () => Option.none(),
      ImageLines: () => Option.none(),
    }),
    (focus: Focus<GameFile>) => focus.compose(holding(source)),
  );

/** The text of a plugin setting, as long as it is still `source`. */
export const pluginFocus = (
  plugins: Plugins,
  plugin: string,
  keys: ReadonlyArray<string>,
  source: string,
) =>
  Option.map(
    intoRecord(
      Optic.id<Plugins>()
        .at(plugins.findLastIndex((entry) => entry?.status && entry.name === plugin))
        .refine(Predicate.isNotNull)
        .key("parameters"),
      keys,
    ),
    (focus) => focus.compose(holding(source)),
  );
