import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Play from "./Play.ts";

// Game files aren't JSON, so these are plain routes, not part of the HttpApi; a failure answers
// with its message as text, which the game shows as a load error.
const failure = (status: number) => (error: { readonly message: string }) =>
  Effect.succeed(HttpServerResponse.text(error.message, { status }));
const logged = (status: number) => (error: { readonly message: string }) =>
  Effect.logError("A played game's file failed", error).pipe(
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
  }),
);
