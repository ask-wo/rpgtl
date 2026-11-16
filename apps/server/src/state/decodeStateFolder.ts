import { Games, ImageReadResults, Playtime, RunLogLine, Samples, Settings } from "@rpgtl/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readCatalogAt } from "../games/catalogRows.ts";
import * as StateFolder from "./StateFolder.ts";

type Folder = StateFolder.StateFolder["Service"];
type Read = (folder: Folder, file: string) => Effect.Effect<unknown, StateFolder.StateFileError>;

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(RunLogLine));

/** Each line of a run log, which is one JSON value per line. */
const readRunLog = Effect.fn("decodeStateFolder.readRunLog")(function* (
  folder: Folder,
  file: string,
) {
  const text = new TextDecoder().decode(yield* folder.readBytes(file));
  for (const [index, line] of text.split("\n").entries())
    if (line.trim())
      yield* decodeLine(line).pipe(
        Effect.mapError(
          (cause) =>
            new StateFolder.StateFileError({
              file: `${file}:${index + 1}`,
              operation: "read",
              cause,
            }),
        ),
      );
});

/** The game's database, read as the server reads it, without writing to it. */
const readDatabase: Read = (folder, file) =>
  readCatalogAt(`${folder.root}/${file}`, { id: "", title: "", engine: "MV" }).pipe(
    // oxlint-disable-next-line rpgtl/no-catch-all -- a row that doesn't decode dies, and it is as much this file's problem as a failed query.
    Effect.catchCause((cause) =>
      Effect.fail(
        new StateFolder.StateFileError({ file, operation: "read", cause: Cause.squash(cause) }),
      ),
    ),
  );

/** A game's files by their path in `games/<game id>/`, each read as the server reads it. */
const gameKinds: ReadonlyArray<{ readonly name: RegExp; readonly read: Read }> = [
  { name: /^game\.db$/, read: readDatabase },
  { name: /^images\.json$/, read: (folder, file) => folder.read(file, ImageReadResults) },
  { name: /^samples\.json$/, read: (folder, file) => folder.read(file, Samples) },
  { name: /^playtime\.json$/, read: (folder, file) => folder.read(file, Playtime) },
  { name: /^logs\/translation-[^/]+\.log$/, read: readRunLog },
];

export interface Decoded {
  readonly file: string;
  /** Why the file doesn't decode; none when it does. */
  readonly problem?: string;
}

const decoded = (read: Effect.Effect<unknown, StateFolder.StateFileError>, file: string) =>
  read.pipe(
    Effect.as<Decoded>({ file }),
    Effect.catchTags({
      StateFileError: (error) => Effect.succeed({ file, problem: String(error.cause) }),
    }),
  );

/**
 * Decodes `games.json` and each file in the game folders that the server reads, game databases
 * and run logs included, without writing anything. Files of no known kind, such as reports, are
 * left out.
 */
export const decodeStateFolder = Effect.fn("decodeStateFolder")(function* () {
  const folder = yield* StateFolder.StateFolder;
  const results: Array<Decoded> = [yield* decoded(folder.read("games.json", Games), "games.json")];
  for (const id of (yield* folder.list("games")).toSorted()) {
    const dir = `games/${id}`;
    const names = [
      ...(yield* folder.list(dir)),
      ...(yield* folder.list(`${dir}/logs`)).map((name) => `logs/${name}`),
    ];
    for (const name of names.toSorted()) {
      const kind = gameKinds.find((known) => known.name.test(name));
      if (kind) results.push(yield* decoded(kind.read(folder, `${dir}/${name}`), `${dir}/${name}`));
    }
  }
  return results;
});

/** Decodes the settings file `name` in `folder` as the server reads it; a missing file fails. */
export const decodeSettings = (folder: Folder, name: string) =>
  folder.read(name, Settings).pipe(
    Effect.map((saved): Decoded =>
      Option.isSome(saved) ? { file: name } : { file: name, problem: "There is no such file." },
    ),
    Effect.catchTags({
      StateFileError: (error) => Effect.succeed({ file: name, problem: String(error.cause) }),
    }),
  );
