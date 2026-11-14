import { PlayedSeconds } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ownOrigin } from "../auth/LocalRequest.ts";
import * as Play from "./Play.ts";
import * as Playtime from "./Playtime.ts";

// Game files aren't JSON, and the game page has no session token, so these are plain routes, not
// part of the HttpApi. A failure answers with its message as text, which the game shows as a load
// error.
const failure = (status: number) => (error: { readonly message: string }) =>
  Effect.succeed(HttpServerResponse.text(error.message, { status }));
const logged = (status: number) => (error: { readonly message: string }) =>
  Effect.logError("A game played in the browser failed", error).pipe(
    Effect.andThen(failure(status)(error)),
  );

const gameFile = Effect.fn("play.file")(
  function* () {
    const play = yield* Play.Play;
    const { id = "", "*": relative = "" } = yield* HttpRouter.params;
    const file = yield* play.file(id, relative);
    return yield* Play.PlayFile.$match(file, {
      Stored: ({ path }) => HttpServerResponse.file(path),
      Made: ({ text, contentType }) =>
        Effect.succeed(HttpServerResponse.text(text, { contentType })),
      Read: ({ bytes, contentType }) =>
        Effect.succeed(HttpServerResponse.uint8Array(bytes, { contentType })),
    });
  },
  Effect.catchTags({
    GameNotInspectedError: failure(404),
    GameFileMissingError: failure(404),
    GameFileInvalid: failure(400),
    GameDataChanged: failure(400),
    GameFileReadError: logged(500),
    StateFileError: logged(500),
    PlatformError: logged(500),
  }),
);

const erasedImage = Effect.fn("play.erasedImage")(
  function* () {
    const play = yield* Play.Play;
    const { id = "", name = "" } = yield* HttpRouter.params;
    const file = yield* play.erasedImage(id, name);
    if (Option.isNone(file)) return HttpServerResponse.text("Not found.", { status: 404 });
    return yield* HttpServerResponse.file(file.value);
  },
  Effect.catchTags({
    GameNotInspectedError: failure(404),
    StateFileError: logged(500),
    PlatformError: logged(500),
  }),
);

// The game page has no session token, as the game's own scripts would get it too. Origin is
// checked instead, since a browser sends it with every POST, and other sites can't set it.
const recordPlaytime = Effect.fn("play.playtime")(
  function* () {
    const { headers } = yield* HttpServerRequest.HttpServerRequest;
    if (headers.origin !== (yield* ownOrigin))
      return HttpServerResponse.text("Invalid origin.", { status: 403 });
    const { id = "" } = yield* HttpRouter.params;
    const { seconds } = yield* HttpServerRequest.schemaBodyJson(
      Schema.Struct({ seconds: PlayedSeconds }),
    );
    yield* Effect.flatMap(Playtime.Playtime, (playtime) => playtime.add(id, seconds));
    return HttpServerResponse.empty({ status: 204 });
  },
  Effect.catchTags({
    SchemaError: failure(400),
    HttpServerError: failure(400),
    GameNotInspectedError: failure(404),
    StateFileError: logged(500),
  }),
);

/** The games the page plays in the browser, under `/game/<id>/`. */
export const routes = HttpRouter.use(
  Effect.fn(function* (router) {
    // This also matches `/game/<id>`, which goes to `/game/<id>/` so that the game's own relative
    // addresses resolve below it.
    yield* router.add("GET", "/game/:id/*", (request) => {
      const { pathname } = new URL(request.url, "http://127.0.0.1");
      return pathname.split("/").length === 3
        ? Effect.succeed(HttpServerResponse.redirect(`${pathname}/`))
        : gameFile();
    });
    yield* router.add("GET", "/erased/:id/:name", erasedImage());
    yield* router.add("POST", "/playtime/:id", recordPlaytime());
  }),
);
