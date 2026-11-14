import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Catalog, Game, OtherVersion } from "@rpgtl/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Catalogs from "../games/Catalogs.ts";
import * as GameFolder from "../games/GameFolder.ts";
import * as Games from "../games/Games.ts";
import * as ImageReader from "../imageText/ImageReader.ts";
import * as ImageReaderSetup from "../imageText/ImageReaderSetup.ts";
import * as ImageReading from "../imageText/ImageReading.ts";
import * as ImageTexts from "../imageText/ImageTexts.ts";
import * as XpImages from "../imageText/XpImages.ts";
import * as VisionModel from "../imageText/VisionModel.ts";
import * as StateFolder from "../state/StateFolder.ts";
import * as FreeMemory from "../localModels/FreeMemory.ts";
import * as AgentModels from "../translation/AgentModels.ts";
import { NvidiaSmi } from "../localModels/FreeMemory.ts";
import * as LlamaServer from "../localModels/LlamaServer.ts";
import * as Launches from "../nwjs/Launches.ts";
import * as Mkxpz from "../mkxpz/Mkxpz.ts";
import * as Nwjs from "../nwjs/Nwjs.ts";
import * as Play from "../play/Play.ts";
import * as Playtime from "../play/Playtime.ts";
import * as Settings from "../settings/Settings.ts";
import * as Frontend from "../frontend/Frontend.ts";
import * as RunLogs from "../translation/RunLogs.ts";
import * as Runs from "../translation/Runs.ts";
import * as RunKinds from "../runs/RunKinds.ts";

export const game: Game = {
  id: "0123456789abcdef0123",
  root: "/games/rain",
  webRoot: "/games/rain/www",
  engine: "MV",
  title: "雨",
  files: ["Map001.json"],
  encryptedAssets: false,
  mediaWarnings: [],
  missingImages: [],
};
export const other: Game = { ...game, id: "fedcba9876543210fedc", title: "甜" };

export class StateDir extends Context.Service<StateDir, string>()(
  "@rpgtl/server/testUtils/StateDir",
) {}

/** Points `RPGTL_DIR` at a new state folder holding `files`, removed when the test ends. */
const stateFolderWith = (files: Record<string, string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      for (const [name, text] of Object.entries(files)) {
        yield* fs.makeDirectory(path.dirname(path.join(dir, name)), { recursive: true });
        yield* fs.writeFileString(path.join(dir, name), text);
      }
      return Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            RPGTL_DIR: dir,
            XDG_CONFIG_HOME: path.join(dir, "config"),
            HOME: dir,
          }),
        ),
        Layer.succeed(StateDir, dir),
      );
    }),
  );

/** The game `inspecting` opens, failing the test when it asks about another version first. */
export const opened = <E, R>(
  inspecting: Effect.Effect<
    { readonly game: Game; readonly catalog: Catalog } | { readonly otherVersion: OtherVersion },
    E,
    R
  >,
) =>
  Effect.filterOrElse(
    inspecting,
    (result) => "game" in result,
    (result) =>
      Effect.die(new Error(`Asked about another version of ${result.otherVersion.game.title}`)),
  );

/** The state services over a new state folder holding `files`. */
export const servicesWith = (files: Record<string, string>) =>
  Catalogs.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Games.layer, GameFolder.layer, ImageTexts.layer)),
    Layer.provideMerge(StateFolder.layer),
    Layer.provideMerge(stateFolderWith(files)),
  );

/** The image reader's setup in a cache folder that doesn't exist, on a computer without NVIDIA's tools. */
export const noImageReader = ImageReaderSetup.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nowhere" })),
      Layer.succeed(NvidiaSmi, "/nowhere/nvidia-smi"),
    ),
  ),
  Layer.provide(NodeChildProcessSpawner.layer),
);

/** What the image reader needs besides its process: a setup that isn't done, and run kinds. */
export const readerNeeds = Layer.mergeAll(noImageReader, RunKinds.layer).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

/**
 * Translation runs and image reading over the state services, with the real run logs,
 * llama-server, an image reader that isn't set up, and settings in the state folder's `config/`.
 */
export const runServices = Layer.mergeAll(Runs.layer, ImageReading.layer).pipe(
  Layer.provide(Layer.mergeAll(RunLogs.layer, VisionModel.layer)),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(
    Layer.mergeAll(LlamaServer.layer, ImageReader.layer.pipe(Layer.provide(noImageReader))),
  ),
  Layer.provideMerge(RunKinds.layer),
  Layer.provideMerge(AgentModels.layer),
  Layer.provide(FreeMemory.layer),
  Layer.provide(NodeChildProcessSpawner.layer),
);

/** NW.js and mkxp-z in a cache folder that doesn't exist, so they are never downloaded. */
export const noPrograms = Layer.mergeAll(Nwjs.layer, Mkxpz.layer).pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nowhere" }))),
  Layer.provide(NodeChildProcessSpawner.layer),
);

/**
 * Playing games in the browser and in NW.js, with settings in the state folder's `config/`; needs
 * NW.js and the state services.
 */
export const playServices = Layer.mergeAll(Play.layer, Playtime.layer, Launches.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Settings.layer, Frontend.layer, XpImages.layer)),
  Layer.provide(NodeChildProcessSpawner.layer),
);
