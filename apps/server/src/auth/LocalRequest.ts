import { LocalRequest, RequestRefused } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as NetAddress from "effect/net/NetAddress";
import * as Schema from "effect/Schema";
import * as SessionToken from "./SessionToken.ts";

/** The port RPGTL listens on, which the host and origin of its own page name. */
export const listeningPort = Effect.map(HttpServer.HttpServer, ({ address }) =>
  NetAddress.isInetAddress(address) ? address.port : 0,
);

const refuse = (message: string) => new RequestRefused({ message });
const hostRefusal = HttpServerResponse.jsonUnsafe(
  Schema.encodeSync(RequestRefused)(refuse("Invalid host.")),
  { status: 403 },
);

const ownHost = Effect.map(listeningPort, (port) => `127.0.0.1:${port}`);
/** The origin of RPGTL's own page and of the games it plays in the browser. */
export const ownOrigin = Effect.map(ownHost, (host) => `http://${host}`);

/**
 * Refuses every request, the page and the games' files too, whose `Host` isn't RPGTL's own, so a
 * site whose name points at 127.0.0.1 can't read them.
 */
export const hostCheck = HttpRouter.middleware(
  Effect.gen(function* () {
    const host = yield* ownHost;
    return (httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, ({ headers }) =>
        headers.host === host ? httpEffect : Effect.succeed(hostRefusal),
      );
  }),
  { global: true },
);

/** API requests also need this start's token, and an origin, if any, of RPGTL's own page. */
export const layer = Layer.effect(
  LocalRequest,
  Effect.gen(function* () {
    const token = yield* SessionToken.SessionToken;
    const origin = yield* ownOrigin;
    return LocalRequest.of((httpEffect) =>
      Effect.gen(function* () {
        const { headers } = yield* HttpServerRequest.HttpServerRequest;
        if (headers["x-rpgtl-token"] !== token) return yield* refuse("Reload RPGTL to connect.");
        if (headers.origin !== undefined && headers.origin !== origin)
          return yield* refuse("Invalid origin.");
        return yield* httpEffect;
      }),
    );
  }),
);
