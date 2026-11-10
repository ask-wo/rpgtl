import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { IncomingMessage, ServerResponse } from "node:http";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Frontend from "./Frontend.ts";

const notFound = HttpServerResponse.text("Not found.", { status: 404 });

const failed = (error: Frontend.FrontendFileError) =>
  Effect.logError(error.message, error.cause).pipe(
    Effect.as(HttpServerResponse.text(error.message, { status: 500 })),
  );

const script = (file: Frontend.ScriptFile) =>
  Effect.fn("frontend.script")(
    function* () {
      const frontend = yield* Frontend.Frontend;
      const text = yield* frontend.script(file);
      return HttpServerResponse.text(text, { contentType: "text/javascript; charset=utf-8" });
    },
    Effect.catchTags({ FrontendFileError: failed }),
  );

/**
 * A path with no file extension is one of the page's own routes, such as `/games/<id>`; an API
 * path that matched no endpoint stays a 404.
 */
const isPageRoute = (pathname: string) =>
  !pathname.startsWith("/api/") && !/\.[^/]*$/.test(pathname);

type Built = Extract<Frontend.Page, { readonly _tag: "Built" }>;

const builtFile = ({ file }: Built) =>
  Effect.fn("frontend.page")(
    function* (request: HttpServerRequest.HttpServerRequest) {
      const { pathname } = new URL(request.url, "http://127.0.0.1");
      const found = yield* file(pathname);
      if (Option.isSome(found)) return pageResponse(found.value);
      if (!isPageRoute(pathname)) return notFound;
      return Option.match(yield* file("/index.html"), {
        onNone: () => notFound,
        onSome: pageResponse,
      });
    },
    Effect.catchTags({ FrontendFileError: failed }),
  );

const pageResponse = ({ body, contentType }: Frontend.PageFile) =>
  typeof body === "string"
    ? HttpServerResponse.text(body, { contentType })
    : HttpServerResponse.uint8Array(body, { contentType });

type Dev = Extract<Frontend.Page, { readonly _tag: "Dev" }>;

/**
 * Hands the request to Vite's dev server, which writes the response itself; the server sends
 * nothing more for a response Vite has ended.
 */
const devFile = ({ middlewares }: Dev) =>
  Effect.fn("frontend.devPage")(function* (request: HttpServerRequest.HttpServerRequest) {
    const incoming = NodeHttpServerRequest.toIncomingMessage(request);
    const outgoing = NodeHttpServerRequest.toServerResponse(request);
    if (!(incoming instanceof IncomingMessage) || !(outgoing instanceof ServerResponse))
      return notFound;
    const handled = yield* Effect.callback<boolean>((resume) => {
      outgoing.once("close", () => resume(Effect.succeed(true)));
      middlewares(incoming, outgoing, () => resume(Effect.succeed(false)));
    });
    return handled ? HttpServerResponse.empty() : notFound;
  });

/** RPGTL's page and the scripts it puts into the games it plays. */
export const routes = HttpRouter.use(
  Effect.fn(function* (router) {
    for (const file of ["runtime.js", "map-view.js"] as const)
      yield* router.add("GET", `/${file}`, script(file)());
    const { page } = yield* Frontend.Frontend;
    yield* router.add("GET", "/*", Frontend.Page.$match(page, { Built: builtFile, Dev: devFile }));
  }),
);
