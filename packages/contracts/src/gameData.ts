import * as Schema from "effect/Schema";

/**
 * The parts of RPG Maker MV/MZ data files that RPGTL reads. Each object keeps the fields RPGTL
 * doesn't know, so a translated file holds everything the game's own file does. Decoding puts the
 * fields named here first.
 */
const open = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);

export const EventCommand = open({ code: Schema.Int, parameters: Schema.Array(Schema.Unknown) });
export type EventCommand = typeof EventCommand.Type;

export const EventList = Schema.Array(EventCommand);
export type EventList = typeof EventList.Type;

const EventPage = open({ list: EventList });

export const MapEvent = open({ pages: Schema.Array(EventPage) });
export type MapEvent = typeof MapEvent.Type;

export const GameMap = open({ events: Schema.Array(Schema.NullOr(MapEvent)) });
export type GameMap = typeof GameMap.Type;

export const CommonEvents = Schema.Array(Schema.NullOr(open({ list: EventList })));
export type CommonEvents = typeof CommonEvents.Type;

export const Troops = Schema.Array(Schema.NullOr(open({ pages: Schema.Array(EventPage) })));
export type Troops = typeof Troops.Type;

/** A record of a database file such as Actors.json or Items.json, or of MapInfos or Tilesets. */
export const GameRecord = Schema.Record(Schema.String, Schema.Unknown);
export type GameRecord = typeof GameRecord.Type;

export const GameRecords = Schema.Array(Schema.NullOr(GameRecord));
export type GameRecords = typeof GameRecords.Type;

export const GameSystem = Schema.Record(Schema.String, Schema.Unknown);
export type GameSystem = typeof GameSystem.Type;

/** An entry of the `$plugins` list in js/plugins.js. */
export const Plugin = open({
  name: Schema.String,
  status: Schema.Boolean,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
});
export type Plugin = typeof Plugin.Type;

export const Plugins = Schema.Array(Schema.NullOr(Plugin));
export type Plugins = typeof Plugins.Type;
