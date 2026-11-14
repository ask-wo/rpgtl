import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { OnWindows } from "./OnWindows.ts";
import * as Activity from "./activity/Activity.ts";
import * as Catalogs from "./games/Catalogs.ts";
import * as FolderBrowser from "./games/FolderBrowser.ts";
import * as GameFolder from "./games/GameFolder.ts";
import * as Games from "./games/Games.ts";
import * as ImageReader from "./imageText/ImageReader.ts";
import * as ImageReaderSetup from "./imageText/ImageReaderSetup.ts";
import * as ImageReading from "./imageText/ImageReading.ts";
import * as XpImages from "./imageText/XpImages.ts";
import * as ImageTexts from "./imageText/ImageTexts.ts";
import * as VisionModel from "./imageText/VisionModel.ts";
import * as RunKinds from "./runs/RunKinds.ts";
import * as FreeMemory from "./localModels/FreeMemory.ts";
import * as LlamaServer from "./localModels/LlamaServer.ts";
import * as Launches from "./nwjs/Launches.ts";
import * as Mkxpz from "./mkxpz/Mkxpz.ts";
import * as Nwjs from "./nwjs/Nwjs.ts";
import * as Play from "./play/Play.ts";
import * as Playtime from "./play/Playtime.ts";
import * as Settings from "./settings/Settings.ts";
import * as Frontend from "./frontend/Frontend.ts";
import * as AgentModels from "./translation/AgentModels.ts";
import * as Ollama from "./localModels/Ollama.ts";
import * as RunLogs from "./translation/RunLogs.ts";
import * as Runs from "./translation/Runs.ts";
import * as Http from "./http.ts";
import * as SessionToken from "./auth/SessionToken.ts";
import * as StateFolder from "./state/StateFolder.ts";
import * as XpPatch from "./xpPatch/XpPatch.ts";

const port = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  "PORT",
).pipe(Config.withDefault(47831));

/** Every service, each built once, with the page and game scripts from `frontend`. */
const services = <E, R>(frontend: Layer.Layer<Frontend.Frontend, E, R>) =>
  Layer.mergeAll(Activity.layer, XpPatch.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Runs.layer, ImageReading.layer, Launches.layer, Play.layer, Playtime.layer),
    ),
    Layer.provideMerge(XpImages.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Catalogs.layer,
        RunLogs.layer,
        VisionModel.layer,
        Nwjs.layer,
        Mkxpz.layer,
        frontend,
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(LlamaServer.layer, ImageReader.layer)),
    Layer.provideMerge(
      Layer.mergeAll(Ollama.layer, AgentModels.layer, FreeMemory.layer, ImageReaderSetup.layer),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Games.layer,
        GameFolder.layer,
        FolderBrowser.layer,
        ImageTexts.layer,
        RunKinds.layer,
        Settings.layer,
      ),
    ),
    Layer.provideMerge(StateFolder.layer),
    Layer.provideMerge(SessionToken.layer),
    Layer.provide(SecureRandom.layerWebCrypto),
    // A translation endpoint must be on this computer, so its redirects aren't followed and the
    // text stays here. Only the NW.js download follows them.
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** Opens `url` in the desktop's browser; a failure leaves it to the ready line. */
const openInBrowser = Effect.fnUntraced(function* (url: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [command, ...args] = (yield* OnWindows)
    ? ["rundll32", "url.dll,FileProtocolHandler", url]
    : ["xdg-open", url];
  // Unreferenced, the opener and a browser it runs in the foreground outlive RPGTL.
  yield* spawner
    .spawn(
      ChildProcess.make(command ?? "", args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.flatMap((handle) => handle.unref),
      Effect.scoped,
      Effect.catchTags({ PlatformError: () => Effect.void }),
    );
});

const ready = (openPage: boolean) =>
  Layer.effectDiscard(
    HttpServer.addressFormattedWith((url) =>
      Console.log(`RPGTL is ready: ${url}/`).pipe(
        Effect.andThen(openPage ? openInBrowser(`${url}/`) : Effect.void),
      ),
    ),
  );

/**
 * RPGTL's server on `127.0.0.1` at `PORT`, with the page and game scripts from `frontend`; it says
 * where once it listens, and with `openPage` opens the page in the browser.
 */
export const serve = <E, R>(
  frontend: Layer.Layer<Frontend.Frontend, E, R>,
  options: { readonly openPage: boolean },
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Each provide builds its layer before the ones above it: the services, then the server, the
      // routes and last the ready line.
      return ready(options.openPage).pipe(
        Layer.provide(
          HttpRouter.serve(Http.routes, { disableLogger: true, disableListenLog: true }),
        ),
        Layer.provide(
          NodeHttpServer.layer(createServer, {
            host: "127.0.0.1",
            port: yield* port,
            // An open page keeps NW.js's status streams open, which would hold up every stop.
            gracefulShutdownTimeout: "1 second",
          }),
        ),
        Layer.provideMerge(services(frontend)),
      );
    }),
  );
