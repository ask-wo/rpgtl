import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import { GameActivity } from "./activity.ts";
import {
  Catalog,
  EntryProblem,
  entryProblem,
  TermEdit,
  LetteringFont,
  SourceLanguage,
} from "./catalog.ts";
import { Findings } from "./checks.ts";
import { CatalogChange } from "./catalogChange.ts";
import { FolderListing, Game, ListedGame, OtherVersion, Playtime, VersionChoice } from "./game.ts";
import {
  ImportPreview,
  TranslationFileProblem,
  translationFileProblem,
} from "./translationFile.ts";
import { EndpointProblem, endpointProblem } from "./localEndpoint.ts";
import { GameLaunch, ProgramStatus } from "./nwjs.ts";
import { Settings } from "./settings.ts";
import { AgentModel, QueuedRun, RunKind, RunStatus } from "./translation.ts";
import {
  ExportedImageText,
  ImageReaderSetupStatus,
  ImageReadResults,
  ImageRunStatus,
  ReadAgain,
} from "./imageText.ts";

/** A message the constructor fills in, so callers write `new GameBusy()`. */
const fixedMessage = (text: string) =>
  Schema.String.pipe(Schema.optionalKey, Schema.withConstructorDefault(Effect.succeed(text)));

export class GameNotInspected extends Schema.TaggedError<GameNotInspected>()(
  "GameNotInspected",
  { message: fixedMessage("Inspect the game first.") },
  { httpApiStatus: 400 },
) {}

/** Another operation on the game holds it, such as a run or a save. */
export class GameBusy extends Schema.TaggedError<GameBusy>()(
  "GameBusy",
  { message: fixedMessage("This game is busy. Wait for the current operation.") },
  { httpApiStatus: 400 },
) {}

/** The image reader is being set up or reads images, so it can't be removed now. */
export class ImageReaderBusy extends Schema.TaggedError<ImageReaderBusy>()(
  "ImageReaderBusy",
  {
    message: fixedMessage(
      "The image reader is in use. Wait until setting it up or reading images has finished.",
    ),
  },
  { httpApiStatus: 400 },
) {}

/** A file in the state or settings folder that can't be read, decoded or written; the server logs why. */
export class StateFileFailed extends Schema.TaggedError<StateFileFailed>()(
  "StateFileFailed",
  { file: Schema.String, operation: Schema.Literals(["read", "write"]), message: Schema.String },
  { httpApiStatus: 500 },
) {
  static forFile(file: string, operation: "read" | "write") {
    return new StateFileFailed({ file, operation, message: `Couldn't ${operation} ${file}.` });
  }
}

export class GamePathMissing extends Schema.TaggedError<GamePathMissing>()(
  "GamePathMissing",
  { message: fixedMessage("Enter a game folder or executable path.") },
  { httpApiStatus: 400 },
) {}

export class NoGameFound extends Schema.TaggedError<NoGameFound>()(
  "NoGameFound",
  {
    message: fixedMessage(
      "No unpacked RPG Maker MV/MZ game found. Select a folder containing index.html, js, and data, or its parent.",
    ),
  },
  { httpApiStatus: 400 },
) {}

/** A file of the game that can't be read, or whose data isn't what its name says. */
export class GameFileFailed extends Schema.TaggedError<GameFileFailed>()(
  "GameFileFailed",
  { file: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {
  static missing(file: string) {
    return new GameFileFailed({ file, message: `${file} isn't a file in the game folder.` });
  }
  static unreadable(file: string) {
    return new GameFileFailed({ file, message: `Couldn't read ${file}.` });
  }
  static invalid(file: string, problem: string) {
    return new GameFileFailed({ file, message: `${file} can't be read: ${problem}` });
  }
}

/** A folder chosen for a moved game whose text doesn't match the game's. */
export class NotSameGame extends Schema.TaggedError<NotSameGame>()(
  "NotSameGame",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {
  static at(path: string, title: string) {
    return new NotSameGame({
      message: `The game at ${path} isn't ${title}: too little of its text matches.`,
    });
  }
}

/** A folder chosen for a moved game that RPGTL already keeps another game's translations for. */
export class GameFolderTaken extends Schema.TaggedError<GameFolderTaken>()(
  "GameFolderTaken",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {
  static at(path: string) {
    return new GameFolderTaken({
      message: `RPGTL already keeps translations for the game at ${path}. Open it from there instead.`,
    });
  }
}

/** A folder the folder browser can't list, such as one the user may not read. */
export class FolderUnreadable extends Schema.TaggedError<FolderUnreadable>()(
  "FolderUnreadable",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {
  static at(path: string) {
    return new FolderUnreadable({ message: `Can't read the folder ${path}.` });
  }
}

/** A translation file that doesn't fit the game's catalog. */
export class TranslationFileRejected extends Schema.TaggedError<TranslationFileRejected>()(
  "TranslationFileRejected",
  { problem: TranslationFileProblem, message: Schema.String },
  { httpApiStatus: 400 },
) {
  static because(problem: TranslationFileProblem, detail?: string) {
    return new TranslationFileRejected({
      problem,
      message: translationFileProblem(problem, detail),
    });
  }
}

/** A glossary the page sent that can't be saved, such as one listing a source twice. */
export class GlossaryRejected extends Schema.TaggedError<GlossaryRejected>()(
  "GlossaryRejected",
  { source: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {
  static repeated(source: string) {
    return new GlossaryRejected({
      source,
      message: `${source} is in the glossary twice. Each term can be listed only once.`,
    });
  }
}

/** An edited translation the page sent that can't be saved, such as one without its control codes. */
export class EntryRejected extends Schema.TaggedError<EntryRejected>()(
  "EntryRejected",
  { id: Schema.String, problem: EntryProblem, message: Schema.String },
  { httpApiStatus: 400 },
) {
  static because(id: string, problem: EntryProblem) {
    return new EntryRejected({ id, problem, message: entryProblem(problem) });
  }
}

export class ImageReaderRemoving extends Schema.TaggedError<ImageReaderRemoving>()(
  "ImageReaderRemoving",
  { message: fixedMessage("The image reader is being removed.") },
  { httpApiStatus: 400 },
) {}

/** A translation endpoint that isn't an HTTP server on this computer. */
export class EndpointRejected extends Schema.TaggedError<EndpointRejected>()(
  "EndpointRejected",
  { problem: EndpointProblem, message: Schema.String },
  { httpApiStatus: 400 },
) {
  static because(problem: EndpointProblem) {
    return new EndpointRejected({ problem, message: endpointProblem(problem) });
  }
}

export class OllamaUnreachable extends Schema.TaggedError<OllamaUnreachable>()(
  "OllamaUnreachable",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {
  static at(origin: string) {
    return new OllamaUnreachable({
      message: `Could not reach Ollama at ${origin}. Is it running?`,
    });
  }
}

/** A model Ollama doesn't have, or whose file it doesn't name. */
export class OllamaModelMissing extends Schema.TaggedError<OllamaModelMissing>()(
  "OllamaModelMissing",
  { model: Schema.String, problem: Schema.Literals(["unknown", "noFile"]), message: Schema.String },
  { httpApiStatus: 400 },
) {
  static because(model: string, problem: "unknown" | "noFile") {
    return new OllamaModelMissing({
      model,
      problem,
      message:
        problem === "unknown"
          ? `Ollama has no model named ${model}.`
          : `Ollama did not name the model file of ${model}.`,
    });
  }
}

export class EngineUnsupported extends Schema.TaggedError<EngineUnsupported>()(
  "EngineUnsupported",
  { message: fixedMessage("RPGTL can't do this for games of this engine yet.") },
  { httpApiStatus: 400 },
) {}

export class ProgramMissing extends Schema.TaggedError<ProgramMissing>()(
  "ProgramMissing",
  { message: fixedMessage("Download the program the game plays in first.") },
  { httpApiStatus: 400 },
) {}

export class GameRunning extends Schema.TaggedError<GameRunning>()(
  "GameRunning",
  { message: fixedMessage("The game is already running. Close it to start it again.") },
  { httpApiStatus: 400 },
) {}

/** The game's program couldn't be started, or its files for the game couldn't be made; the server logs why. */
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()(
  "LaunchFailed",
  { message: fixedMessage("Couldn't start the game. RPGTL's log says why.") },
  { httpApiStatus: 500 },
) {}

/** The game's program didn't end when asked to; the server logs why. */
export class StopFailed extends Schema.TaggedError<StopFailed>()(
  "StopFailed",
  { message: fixedMessage("Couldn't stop the game. RPGTL's log says why.") },
  { httpApiStatus: 500 },
) {}

/** A request from another host or origin, or without this start's token. */
export class RequestRefused extends Schema.TaggedError<RequestRefused>()(
  "RequestRefused",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Lets through only requests from RPGTL's own page on 127.0.0.1. */
export class LocalRequest extends HttpApiMiddleware.Service<LocalRequest>()(
  "@rpgtl/contracts/LocalRequest",
  { error: RequestRefused },
) {}

const GameId = Schema.Struct({ id: Schema.String });

export class GamesApi extends HttpApiGroup.make("games")
  .add(
    HttpApiEndpoint.get("list", "/games", { success: Schema.Array(ListedGame) }),
    /**
     * Reads the game at a folder or executable path, adds it to the list and rebuilds its catalog,
     * keeping the saved translations. While a run holds the game, gives the saved catalog instead.
     * A game new to the folder that seems to be another version of a saved game gives that game
     * instead, until `choice` says whether to replace it or keep both.
     */
    HttpApiEndpoint.post("inspect", "/inspect", {
      payload: Schema.Struct({ path: Schema.String, choice: Schema.optionalKey(VersionChoice) }),
      success: Schema.Union([
        Schema.Struct({ game: Game, catalog: Catalog }),
        Schema.Struct({ otherVersion: OtherVersion }),
      ]),
      error: [
        GameNotInspected,
        GamePathMissing,
        NoGameFound,
        GameFileFailed,
        GameBusy,
        StateFileFailed,
      ],
    }),
    /**
     * The folders inside the folder at `path`, or the one holding it when it is a file or missing,
     * or the home folder, for the page's folder browser.
     */
    HttpApiEndpoint.get("folders", "/folders", {
      query: Schema.Struct({ path: Schema.optionalKey(Schema.String) }),
      success: FolderListing,
      error: [FolderUnreadable],
    }),
    /**
     * Moves a listed game whose folder moved to the folder at `path`, keeping its id and
     * translations, and rebuilds its catalog there.
     */
    HttpApiEndpoint.post("move", "/games/move", {
      payload: Schema.Struct({ id: Schema.String, path: Schema.String }),
      success: Schema.Struct({ game: Game, catalog: Catalog }),
      error: [
        GameNotInspected,
        GamePathMissing,
        NoGameFound,
        GameFileFailed,
        NotSameGame,
        GameFolderTaken,
        GameBusy,
        StateFileFailed,
      ],
    }),
    /** How long the game was played; null until it is first played. */
    HttpApiEndpoint.get("playtime", "/playtime", {
      query: GameId,
      success: Schema.NullOr(Playtime),
      error: [GameNotInspected, StateFileFailed],
    }),
    /** Removes a game from the list; opening its folder again brings it back with its state. */
    HttpApiEndpoint.post("forget", "/forget", {
      payload: GameId,
      success: Schema.Array(Game),
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

export class CatalogsApi extends HttpApiGroup.make("catalogs")
  .add(
    HttpApiEndpoint.get("get", "/catalog", {
      query: GameId,
      success: Catalog,
      error: [GameNotInspected, StateFileFailed],
    }),
    HttpApiEndpoint.get("checks", "/checks", {
      query: GameId,
      success: Findings,
      error: [GameNotInspected, StateFileFailed],
    }),
    /** The game's catalog and what the checks find in it, then every change to them. */
    HttpApiEndpoint.get("changes", "/catalog/changes", {
      query: GameId,
      success: HttpApiSchema.StreamSse({ data: CatalogChange }),
      error: [GameNotInspected, StateFileFailed],
    }),
    /** Takes the translations, glossary and settings of a translation file, and its image text. */
    HttpApiEndpoint.post("import", "/import", {
      payload: Schema.Struct({ id: Schema.String, catalog: Schema.Unknown }),
      success: Catalog,
      error: [GameNotInspected, GameBusy, TranslationFileRejected, StateFileFailed],
    }),
    /** Counts what importing a translation file would change, without saving anything. */
    HttpApiEndpoint.post("previewImport", "/import/preview", {
      payload: Schema.Struct({ id: Schema.String, catalog: Schema.Unknown }),
      success: ImportPreview,
      error: [GameNotInspected, TranslationFileRejected, StateFileFailed],
    }),
    /** Turns the game's translation switch on or off; translations stay either way. */
    HttpApiEndpoint.post("setTranslate", "/catalog/translate", {
      payload: Schema.Struct({ id: Schema.String, on: Schema.Boolean }),
      success: Catalog,
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
    /** Sets whether an XP game plays with its scripts unchanged; their translations stay. */
    HttpApiEndpoint.post("setOriginalScripts", "/catalog/scripts", {
      payload: Schema.Struct({ id: Schema.String, on: Schema.Boolean }),
      success: Catalog,
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
    /** Sets the language of the game's text; null goes back to the one its text looks like. */
    HttpApiEndpoint.post("setLanguage", "/catalog/language", {
      payload: Schema.Struct({ id: Schema.String, language: Schema.NullOr(SourceLanguage) }),
      success: Catalog,
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
    /**
     * Saves the glossary as the Glossary page edited it, without a backup; an entry that is
     * exactly a term whose English changed follows it.
     */
    HttpApiEndpoint.post("setGlossary", "/glossary", {
      payload: Schema.Struct({ id: Schema.String, glossary: Schema.Array(TermEdit) }),
      error: [GameNotInspected, GameBusy, GlossaryRejected, StateFileFailed],
    }),
    /**
     * Saves the English the Text and Images pages edited, an image's text the user corrected
     * (`text`; the text read undoes the correction), and whether an image text keeps its original
     * artwork, without a backup; an absent field stays as saved.
     */
    HttpApiEndpoint.post("setEntries", "/entries", {
      payload: Schema.Struct({
        id: Schema.String,
        entries: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            translation: Schema.optionalKey(Schema.String),
            text: Schema.optionalKey(Schema.String),
            keepOriginal: Schema.optionalKey(Schema.Boolean),
          }),
        ),
      }),
      error: [GameNotInspected, GameBusy, EntryRejected, StateFileFailed],
    }),
    /**
     * Saves the game's lettering and the images it shows unchanged, without a backup; an absent
     * field stays as saved and null removes it.
     */
    HttpApiEndpoint.post("setImageOptions", "/catalog/images", {
      payload: Schema.Struct({
        id: Schema.String,
        imageBold: Schema.optionalKey(Schema.NullOr(Schema.Literals(["always", "never"]))),
        imageFont: Schema.optionalKey(Schema.NullOr(LetteringFont)),
        unchangedImages: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
    /**
     * Clears the translations that contain one of the terms with these sources, or with
     * `mismatchesOnly` only those that don't use its English, backing up first; gives how many it
     * cleared.
     */
    HttpApiEndpoint.post("clearTermLines", "/glossary/clear-lines", {
      payload: Schema.Struct({
        id: Schema.String,
        sources: Schema.Array(Schema.String),
        mismatchesOnly: Schema.Boolean,
      }),
      success: Schema.Struct({ cleared: Schema.Int }),
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
    /** Clears every translation and what runs left on entries, keeping the English as `previous`. */
    HttpApiEndpoint.post("restore", "/restore", {
      payload: GameId,
      success: Catalog,
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

const agentNames = { claude: "Claude Code", codex: "Codex" } as const;
const agentProblems = {
  missing: (name: string) =>
    name === "Codex"
      ? "The Codex CLI isn't installed. Install it from https://developers.openai.com/codex/cli."
      : "Claude Code isn't installed. Install it from https://code.claude.com/docs/en/setup and sign in once with claude in a terminal.",
  loggedOut: () =>
    "Codex is not logged in. Log in once with rpgtl codex login, or pnpm run codex login in a checkout.",
  failed: (name: string) => `${name} didn't list its models. RPGTL's log says why.`,
};

/** The Claude or Codex CLI couldn't list its models: not installed, not logged in, or failed. */
export class AgentModelsUnavailable extends Schema.TaggedError<AgentModelsUnavailable>()(
  "AgentModelsUnavailable",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {
  static because(translator: "claude" | "codex", problem: keyof typeof agentProblems) {
    return new AgentModelsUnavailable({
      message: agentProblems[problem](agentNames[translator]),
    });
  }
}

export class AgentsApi extends HttpApiGroup.make("agents")
  .add(
    /** The models the Claude or Codex CLI offers its login now, with their effort levels. */
    HttpApiEndpoint.get("models", "/agents/models", {
      query: Schema.Struct({ translator: Schema.Literals(["claude", "codex"]) }),
      success: Schema.Array(AgentModel),
      error: [AgentModelsUnavailable],
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

export class OllamaApi extends HttpApiGroup.make("ollama")
  .add(
    /** Names of the models installed in the Ollama server at `endpoint`, sorted. */
    HttpApiEndpoint.get("models", "/ollama/models", {
      query: Schema.Struct({ endpoint: Schema.String }),
      success: Schema.Array(Schema.String),
      error: [EndpointRejected, OllamaUnreachable],
    }),
    /** How many layers the model has, and how many experts each; 0 experts for a dense model. */
    HttpApiEndpoint.get("modelInfo", "/ollama/model-info", {
      query: Schema.Struct({ endpoint: Schema.String, model: Schema.String }),
      success: Schema.Struct({ blockCount: Schema.Int, expertCount: Schema.Int }),
      error: [EndpointRejected, OllamaUnreachable, OllamaModelMissing],
    }),
    /** Why RPGTL can't run Ollama's bundled llama-server on this system; none when it can. */
    HttpApiEndpoint.get("llamaServer", "/ollama/llama-server", {
      success: Schema.Struct({ unavailable: Schema.optionalKey(Schema.String) }),
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

export class TranslationApi extends HttpApiGroup.make("translation")
  .add(
    /** The game's current or last translation run since RPGTL started; null without one. */
    HttpApiEndpoint.get("status", "/translate", {
      query: GameId,
      success: Schema.NullOr(RunStatus),
      error: [GameNotInspected],
    }),
    /**
     * Starts translating the game's untranslated entries in the background, with the saved
     * settings as they are once its turn comes; until then the run waits.
     */
    HttpApiEndpoint.post("start", "/translate", {
      payload: Schema.Struct({ id: Schema.String, kind: RunKind }),
      success: RunStatus,
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
    /** Stops the game's run, keeping what it saved, and gives its status once it has ended. */
    HttpApiEndpoint.post("stop", "/translate/stop", {
      payload: GameId,
      success: Schema.NullOr(RunStatus),
      error: [GameNotInspected],
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

export class ImagesApi extends HttpApiGroup.make("images")
  .add(
    /** What the image reader found in the game's images; empty before any reading. */
    HttpApiEndpoint.get("results", "/images", {
      query: GameId,
      success: ImageReadResults,
      error: [GameNotInspected, StateFileFailed],
    }),
    /** The read results and erased backgrounds a translation file carries; null without any. */
    HttpApiEndpoint.get("export", "/images/export", {
      query: GameId,
      success: Schema.NullOr(ExportedImageText),
      error: [GameNotInspected, StateFileFailed],
    }),
    /** The game's current or last image reading since RPGTL started; null without one. */
    HttpApiEndpoint.get("status", "/images/read", {
      query: GameId,
      success: Schema.NullOr(ImageRunStatus),
      error: [GameNotInspected],
    }),
    /**
     * Starts reading the game's images in the background, with the saved settings as they are
     * once its turn comes; until then the reading waits. `again` reads those images from scratch.
     */
    HttpApiEndpoint.post("start", "/images/read", {
      payload: Schema.Struct({ id: Schema.String, again: Schema.optionalKey(ReadAgain) }),
      success: ImageRunStatus,
      error: [GameNotInspected, GameBusy, ImageReaderRemoving, StateFileFailed],
    }),
    /** Stops the game's image reading, keeping what it saved, and gives its status once ended. */
    HttpApiEndpoint.post("stop", "/images/read/stop", {
      payload: GameId,
      success: Schema.NullOr(ImageRunStatus),
      error: [GameNotInspected],
    }),
    /** Deletes the game's read results, erased backgrounds and image text entries. */
    HttpApiEndpoint.post("clear", "/images/clear", {
      payload: GameId,
      success: Catalog,
      error: [GameNotInspected, GameBusy, StateFileFailed],
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

export class NwjsApi extends HttpApiGroup.make("nwjs")
  .add(
    /** NW.js's status now and after each change, as Server-Sent Events. */
    HttpApiEndpoint.get("status", "/nwjs", {
      success: HttpApiSchema.StreamSse({ data: ProgramStatus }),
    }),
    /** Starts downloading NW.js unless it is there or on its way; the status tells how far it got. */
    HttpApiEndpoint.post("download", "/nwjs/download", { success: ProgramStatus }),
    /**
     * Starts the game, translated while its translation switch is on, and keeps it running after
     * RPGTL exits: MV and MZ games in NW.js, which reads the saved catalog itself, and XP games in
     * mkxp-z, which reads translated data files RPGTL writes first.
     */
    HttpApiEndpoint.post("launch", "/launch", {
      payload: GameId,
      success: GameLaunch,
      error: [
        GameNotInspected,
        GameBusy,
        EngineUnsupported,
        ProgramMissing,
        GameRunning,
        LaunchFailed,
      ],
    }),
    /**
     * Starts downloading the program Play starts the game in, unless it is there or on its way; the
     * game's activity tells how far it got.
     */
    HttpApiEndpoint.post("downloadProgram", "/launch/download", {
      payload: GameId,
      success: ProgramStatus,
      error: [GameNotInspected],
    }),
    /** Ends the game's program if RPGTL started it and it still runs. */
    HttpApiEndpoint.post("stop", "/launch/stop", {
      payload: GameId,
      error: [GameNotInspected, StopFailed],
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

export class ImageReaderApi extends HttpApiGroup.make("imageReader")
  .add(
    /** Whether the image reader is set up, now and after each change, as Server-Sent Events. */
    HttpApiEndpoint.get("status", "/image-reader", {
      success: HttpApiSchema.StreamSse({ data: ImageReaderSetupStatus }),
    }),
    /**
     * Starts setting up the image reader unless it is set up or on its way: it downloads uv,
     * Python and the reader's packages, and converts the models. The status tells how far it got.
     */
    HttpApiEndpoint.post("setUp", "/image-reader/setup", {
      /** With `korean`, the Korean recognizer too, added to a reader already set up. */
      payload: Schema.Struct({ korean: Schema.Boolean }),
      success: ImageReaderSetupStatus,
    }),
    /** Deletes what setting up the image reader downloaded and made. */
    HttpApiEndpoint.post("remove", "/image-reader/remove", {
      success: ImageReaderSetupStatus,
      error: [ImageReaderBusy, StateFileFailed],
    }),
    /** Deletes the Korean recognizer, keeping the rest of the reader. */
    HttpApiEndpoint.post("removeKorean", "/image-reader/korean/remove", {
      success: ImageReaderSetupStatus,
      error: [ImageReaderBusy, StateFileFailed],
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

export class ActivityApi extends HttpApiGroup.make("activity")
  .add(
    /**
     * What the game's page follows (the program the game plays in, the game's last start,
     * translation run, image reading and import) now and after each change, as Server-Sent Events.
     */
    HttpApiEndpoint.get("changes", "/activity", {
      query: GameId,
      success: HttpApiSchema.StreamSse({ data: GameActivity }),
      error: [GameNotInspected],
    }),
  )
  .add(
    /** Every game's translation runs and image readings that go or wait, now and after each change. */
    HttpApiEndpoint.get("runs", "/activity/runs", {
      success: HttpApiSchema.StreamSse({ data: Schema.Array(QueuedRun) }),
    }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

export class SettingsApi extends HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("get", "/settings", { success: Settings, error: [StateFileFailed] }),
    /** Saves the settings sent in place of the saved ones. */
    HttpApiEndpoint.post("save", "/settings", { payload: Settings, error: [StateFileFailed] }),
  )
  .middleware(LocalRequest)
  .prefix("/api") {}

/** RPGTL's API, shared by the server and the page. */
export class Api extends HttpApi.make("rpgtl")
  .add(GamesApi)
  .add(CatalogsApi)
  .add(OllamaApi)
  .add(AgentsApi)
  .add(TranslationApi)
  .add(ImagesApi)
  .add(NwjsApi)
  .add(ImageReaderApi)
  .add(ActivityApi)
  .add(SettingsApi) {}
