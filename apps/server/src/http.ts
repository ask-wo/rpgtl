import { Api } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as ActivityHttp from "./activity/http.ts";
import * as FrontendHttp from "./frontend/http.ts";
import * as GamesHttp from "./games/http.ts";
import * as ImageTextHttp from "./imageText/http.ts";
import * as NwjsHttp from "./nwjs/http.ts";
import * as PlayHttp from "./play/http.ts";
import * as SettingsHttp from "./settings/http.ts";
import * as TranslationHttp from "./translation/http.ts";
import * as XpPatchHttp from "./xpPatch/http.ts";
import * as LocalRequest from "./auth/LocalRequest.ts";

const noStore = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(
      httpEffect,
      HttpServerResponse.setHeaders({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      }),
    ),
  { global: true },
);

const apiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([
    GamesHttp.layer,
    TranslationHttp.layer,
    ImageTextHttp.layer,
    ImageTextHttp.readerLayer,
    NwjsHttp.layer,
    ActivityHttp.layer,
    SettingsHttp.layer,
    XpPatchHttp.layer,
  ]),
  Layer.provide(LocalRequest.layer),
);

/** Every route: the API, the page and the games it plays in the browser. */
export const routes = Layer.mergeAll(
  apiRoutes,
  PlayHttp.routes,
  FrontendHttp.routes,
  noStore,
  LocalRequest.hostCheck,
);
