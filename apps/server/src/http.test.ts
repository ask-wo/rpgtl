import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Catalog, FolderListing, GameActivity, ProgramStatus, Playtime } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Activity from "./activity/Activity.ts";
import * as XpPatch from "./xpPatch/XpPatch.ts";
import * as FolderBrowser from "./games/FolderBrowser.ts";
import * as Catalogs from "./games/Catalogs.ts";
import * as Games from "./games/Games.ts";
import * as RunKinds from "./runs/RunKinds.ts";
import * as Http from "./http.ts";
import { listeningPort } from "./auth/LocalRequest.ts";
import * as SessionToken from "./auth/SessionToken.ts";
import { folderWith, mvGame } from "./testUtils/gameFolder.ts";
import {
  game,
  noImageReader,
  noPrograms,
  other,
  playServices,
  runServices,
  servicesWith,
  StateDir,
  storedCatalog,
} from "./testUtils/state.ts";
import { ollamaAnswering } from "./testUtils/ollama.ts";
import { testTerm } from "@rpgtl/domain/testUtils/catalog";

const messageAt = (index: number) =>
  ({
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
    index,
  }) as const;

/** The game's catalog as the tests store it, before any request changes it. */
const stored = storedCatalog(game, {
  entries: [
    {
      id: "a",
      location: messageAt(0),
      source: "你好",
      modelTranslation: "Hello 你",
      flagReason: "Check this.",
    },
    {
      id: "b",
      location: messageAt(2),
      source: "再见",
      rejectedTranslation: "Bye bye bye",
      rejectionReason: "too long",
    },
  ],
  glossary: [testTerm("雨", { userTranslation: "Rain", rulesKind: "name" })],
  settings: { isTranslationOn: true },
});

const token = "test-token";

/**
 * Ollama at 127.0.0.1:11434 with two models, of which it shows only qwen:7b; nothing answers at
 * any other port.
 */
const ollama = ollamaAnswering((url, body) =>
  Effect.succeed(
    url.port !== "11434"
      ? Option.none()
      : url.pathname !== "/api/show"
        ? Option.some(Response.json({ models: [{ name: "qwen:7b" }, { name: "hy-mt2:7b" }] }))
        : typeof body === "object" && body && "model" in body && body.model === "qwen:7b"
          ? Option.some(
              Response.json({
                modelfile: "FROM /models/qwen.gguf\n",
                model_info: { "qwen3moe.block_count": 48, "qwen3moe.expert_count": 128 },
              }),
            )
          : Option.some(Response.json({ error: "model not found" }, { status: 404 })),
  ),
);

/** Serves the routes from a new state folder holding `files`. */
const serving = (files: Record<string, string>) =>
  HttpRouter.serve(Http.routes, { disableLogger: true }).pipe(
    Layer.provideMerge(Layer.mergeAll(Activity.layer, XpPatch.layer)),
    Layer.provideMerge(Layer.mergeAll(runServices, playServices, FolderBrowser.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        servicesWith(files),
        ollama,
        Layer.succeed(SessionToken.SessionToken, token),
        noPrograms,
        noImageReader,
      ),
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );

/** The game's catalog as it is saved now, as the API sends it. */
const savedJson = Effect.flatMap(Catalogs.Catalogs, (catalogs) => catalogs.get(game.id)).pipe(
  Effect.map((saved) => JSON.parse(JSON.stringify(Schema.encodeSync(Catalog)(saved)))),
);

const listed = { "games.json": JSON.stringify([game, other]) };
/** The routes over a state folder listing both games, with the first one's catalog stored. */
const withStored = Layer.effectDiscard(Effect.asVoid(stored)).pipe(
  Layer.provideMerge(serving(listed)),
);

const messageOf = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(Schema.Struct({ message: Schema.String }))(response).pipe(
    Effect.map(({ message }) => message),
  );
const Refusal = Schema.Struct({ _tag: Schema.String, problem: Schema.optionalKey(Schema.String) });
/** The status and the error's tag and kind of problem, without its wording. */
const refusal = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(
    HttpClientResponse.schemaBodyJson(Refusal)(response),
    (body) => [response.status, body] as const,
  );
const refused = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(messageOf(response), (message) => [response.status, message] as const);

const withToken = HttpClientRequest.setHeader("X-RPGTL-Token", token);
const get = (url: string) => HttpClient.execute(HttpClientRequest.get(url).pipe(withToken));
const post = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(
    withToken,
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(HttpClient.execute),
  );

it.effect("lists the games and gives a game's catalog and what the checks found in it", () =>
  Effect.gen(function* () {
    const games = yield* get("/api/games");
    assert.strictEqual(games.status, 200);
    assert.strictEqual(games.headers["cache-control"], "no-store");
    assert.deepStrictEqual(yield* games.json, [
      { ...game, folderMissing: true },
      { ...other, folderMissing: true },
    ]);
    assert.deepStrictEqual(
      yield* (yield* get(`/api/catalog?id=${game.id}`)).json,
      yield* savedJson,
    );
    assert.deepStrictEqual(yield* (yield* get(`/api/checks?id=${game.id}`)).json, {
      a: [{ check: "source text left" }],
    });
  }).pipe(Effect.provide(withStored)),
);

it.effect("restoring clears every translation and what runs left", () =>
  Effect.gen(function* () {
    const response = yield* post("/api/restore", { id: game.id });
    assert.strictEqual(response.status, 200);
    const restored = yield* response.json;
    assert.deepStrictEqual(restored, yield* savedJson);
    assert.deepNestedInclude(restored, {
      "texts[0]": { id: 1, source: "你好", isInImage: false, previousTranslation: "Hello 你" },
      "texts[1]": { id: 2, source: "再见", isInImage: false },
    });
  }).pipe(Effect.provide(withStored)),
);

it.effect("the translation switch is saved in the catalog", () =>
  Effect.gen(function* () {
    const off = yield* post("/api/catalog/translate", { id: game.id, on: false });
    assert.strictEqual(off.status, 200);
    const saved = yield* savedJson;
    assert.deepStrictEqual(yield* off.json, saved);
    assert.isFalse(saved.settings.isTranslationOn);

    const games = yield* Games.Games;
    const busy = yield* games.exclusive(
      game.id,
      post("/api/catalog/translate", { id: game.id, on: true }),
    );
    assert.deepStrictEqual(yield* refusal(busy), [400, { _tag: "GameBusy" }]);
  }).pipe(Effect.provide(withStored)),
);

it.effect("removing the image reader waits until images are no longer read", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const reading = yield* Scope.make();
    yield* runKinds.imageReading({ id: other.id, title: other.title }).pipe(Scope.provide(reading));
    const busy = yield* post("/api/image-reader/remove", {});
    assert.deepStrictEqual(yield* refusal(busy), [400, { _tag: "ImageReaderBusy" }]);
    yield* Scope.close(reading, Exit.void);
    const removed = yield* post("/api/image-reader/remove", {});
    assert.strictEqual(removed.status, 200);
  }).pipe(Effect.provide(withStored)),
);

it.effect(
  "the Glossary page saves its glossary, says what is wrong with it, and clears mismatches",
  () =>
    Effect.gen(function* () {
      const hello = { source: "你好", userTranslation: "Hi", userKind: "word" as const };
      const response = yield* post("/api/glossary", { id: game.id, glossary: [hello] });
      assert.strictEqual(response.status, 204);
      const repeated = yield* post("/api/glossary", { id: game.id, glossary: [hello, hello] });
      assert.deepStrictEqual(yield* refusal(repeated), [400, { _tag: "GlossaryRejected" }]);
      const clear = yield* post("/api/glossary/clear-lines", {
        id: game.id,
        sources: ["你好"],
        mismatchesOnly: true,
      });
      assert.deepStrictEqual(yield* clear.json, { cleared: 1 });
      const now = yield* HttpClientResponse.schemaBodyJson(Catalog)(
        yield* get(`/api/catalog?id=${game.id}`),
      );
      assert.deepNestedInclude(now.glossary[0], {
        source: "你好",
        userTranslation: "Hi",
        userKind: "word",
      });
      assert.deepStrictEqual(now.texts[0], {
        id: 1,
        source: "你好",
        isInImage: false,
        previousTranslation: "Hello 你",
      });
    }).pipe(Effect.provide(withStored)),
);

it.effect("the Text page saves edited English and says why an edit can't be saved", () =>
  Effect.gen(function* () {
    const response = yield* post("/api/entries", {
      id: game.id,
      entries: [{ id: "a", userTranslation: "Hello" }],
    });
    assert.strictEqual(response.status, 204);
    const unknown = yield* post("/api/entries", {
      id: game.id,
      entries: [{ id: "gone", userTranslation: "Hi" }],
    });
    assert.deepStrictEqual(yield* refusal(unknown), [
      400,
      { _tag: "EntryRejected", problem: "unknownEntry" },
    ]);
  }).pipe(Effect.provide(withStored)),
);

it.effect("the Images page saves the game's lettering and kept images", () =>
  Effect.gen(function* () {
    const response = yield* post("/api/catalog/images", {
      id: game.id,
      letteringFont: "serif",
      untranslatedImages: ["img/pictures/Logo"],
    });
    assert.strictEqual(response.status, 204);
    const cleared = yield* post("/api/catalog/images", { id: game.id, letteringFont: null });
    assert.strictEqual(cleared.status, 204);
    const now = yield* HttpClientResponse.schemaBodyJson(Catalog)(
      yield* get(`/api/catalog?id=${game.id}`),
    );
    assert.deepStrictEqual(
      [now.settings.letteringFont, now.settings.untranslatedImages],
      [undefined, ["img/pictures/Logo"]],
    );
  }).pipe(Effect.provide(withStored)),
);

it.effect("forgetting a game removes it from the list and keeps it marked, with its catalog", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* (yield* post("/api/forget", { id: game.id })).json, [other]);
    assert.deepStrictEqual(yield* refusal(yield* get(`/api/catalog?id=${game.id}`)), [
      400,
      { _tag: "GameNotInspected" },
    ]);
  }).pipe(Effect.provide(withStored)),
);

it.effect("a game another operation holds refuses restoring and forgetting", () =>
  Effect.gen(function* () {
    const games = yield* Games.Games;
    yield* games.exclusive(
      game.id,
      Effect.gen(function* () {
        for (const route of ["/api/restore", "/api/forget"]) {
          assert.deepStrictEqual(yield* refusal(yield* post(route, { id: game.id })), [
            400,
            { _tag: "GameBusy" },
          ]);
        }
      }),
    );
    assert.strictEqual((yield* post("/api/restore", { id: game.id })).status, 200);
  }).pipe(Effect.provide(withStored)),
);

it.effect(
  "inspecting gives the game and its catalog, after asking about a saved game it may be another version of, and says what is wrong with a path",
  () =>
    Effect.gen(function* () {
      const root = yield* folderWith(mvGame);
      const asked = yield* (yield* post("/api/inspect", { path: root })).json;
      assert.deepNestedInclude(asked, {
        "otherVersion.game.id": game.id,
        "otherVersion.sure": false,
      });
      const inspected = yield* post("/api/inspect", { path: root, choice: "keepBoth" });
      assert.strictEqual(inspected.status, 200);
      const body = yield* inspected.json;
      assert.deepNestedInclude(body, { "game.title": "雨", "catalog.game.title": "雨" });
      assert.notDeepNestedInclude(body, { "game.id": game.id });
      assert.deepStrictEqual(yield* refusal(yield* post("/api/inspect", { path: "" })), [
        400,
        { _tag: "GamePathMissing" },
      ]);
      assert.deepStrictEqual(
        yield* refusal(yield* post("/api/inspect", { path: `${root}/nothing` })),
        [400, { _tag: "NoGameFound" }],
      );
    }).pipe(Effect.provide(withStored)),
);

it.effect(
  "importing counts what the file changes first, saves its translations, and says why a file doesn't fit",
  () =>
    Effect.gen(function* () {
      const edited = {
        version: 2,
        texts: [{ source: "再见", isInImage: false, userTranslation: "Bye" }],
        entries: [],
        glossary: [],
        settings: {},
      };
      const preview = yield* post("/api/import/preview", { id: game.id, catalog: edited });
      assert.strictEqual(preview.status, 200);
      assert.deepInclude(yield* preview.json, {
        translations: { inFile: 1, added: 1, changed: 0, cleared: 0, notInGame: 0 },
      });
      const newer = { ...edited, version: 3 };
      assert.deepStrictEqual(
        yield* refusal(yield* post("/api/import/preview", { id: game.id, catalog: newer })),
        [400, { _tag: "TranslationFileRejected", problem: "newer" }],
      );
      const imported = yield* post("/api/import", { id: game.id, catalog: edited });
      assert.strictEqual(imported.status, 200);
      const result = yield* HttpClientResponse.schemaBodyJson(Catalog)(imported);
      assert.deepStrictEqual(result.texts[1], {
        id: 2,
        source: "再见",
        isInImage: false,
        userTranslation: "Bye",
      });
      const elsewhere = { ...edited, texts: [{ ...edited.texts[0], source: "别处" }] };
      assert.deepStrictEqual(
        yield* refusal(yield* post("/api/import", { id: game.id, catalog: elsewhere })),
        [400, { _tag: "TranslationFileRejected", problem: "otherGame" }],
      );
      assert.deepStrictEqual(
        yield* refusal(yield* post("/api/import", { id: game.id, catalog: newer })),
        [400, { _tag: "TranslationFileRejected", problem: "newer" }],
      );
    }).pipe(Effect.provide(withStored)),
);

it.effect(
  "lists Ollama's models and their layers, and says what is wrong with an endpoint or model",
  () =>
    Effect.gen(function* () {
      const models = yield* get("/api/ollama/models?endpoint=http://127.0.0.1:11434");
      assert.deepStrictEqual(yield* models.json, ["hy-mt2:7b", "qwen:7b"]);
      assert.deepStrictEqual(
        yield* refusal(yield* get("/api/ollama/models?endpoint=http://example.com:11434")),
        [400, { _tag: "EndpointRejected", problem: "notLocal" }],
      );
      assert.deepStrictEqual(
        yield* refusal(yield* get("/api/ollama/models?endpoint=http://127.0.0.1:1")),
        [502, { _tag: "OllamaUnreachable" }],
      );
      const info = (model: string) =>
        get(`/api/ollama/model-info?endpoint=http://127.0.0.1:11434&model=${model}`);
      assert.deepStrictEqual(yield* (yield* info("qwen:7b")).json, {
        blockCount: 48,
        expertCount: 128,
      });
      assert.deepStrictEqual(yield* refusal(yield* info("gone")), [
        400,
        { _tag: "OllamaModelMissing", problem: "unknown" },
      ]);
    }).pipe(Effect.provide(withStored)),
);

it.effect("image reading gives empty results before a run, and says why it can't start", () =>
  Effect.gen(function* () {
    const games = yield* Games.Games;
    assert.deepStrictEqual(yield* (yield* get(`/api/images?id=${game.id}`)).json, {
      version: 1,
      images: {},
    });
    assert.isNull(yield* (yield* get(`/api/images/export?id=${game.id}`)).json);
    assert.isNull(yield* (yield* get(`/api/images/read?id=${game.id}`)).json);
    assert.isNull(yield* (yield* post("/api/images/read/stop", { id: game.id })).json);
    assert.deepStrictEqual(yield* refusal(yield* get("/api/images?id=nope")), [
      400,
      { _tag: "GameNotInspected" },
    ]);

    const start = (body: unknown) => Effect.flatMap(post("/api/images/read", body), refusal);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* RunKinds.RunKinds).readerRemoval;
        assert.deepStrictEqual(yield* refusal(yield* post("/api/images/read", { id: game.id })), [
          400,
          { _tag: "ImageReaderRemoving" },
        ]);
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* games.hold(game.id);
        const busy = [400, { _tag: "GameBusy" }] as const;
        assert.deepStrictEqual(yield* start({ id: game.id }), busy);
        assert.deepStrictEqual(
          yield* refusal(yield* post("/api/images/clear", { id: game.id })),
          busy,
        );
      }),
    );
    const cleared = yield* post("/api/images/clear", { id: game.id });
    assert.deepStrictEqual(yield* cleared.json, yield* savedJson);
  }).pipe(Effect.provide(withStored)),
);

it.effect("lists the folders of the home folder for the page's folder browser", () =>
  Effect.gen(function* () {
    const dir = yield* StateDir;
    const listing = yield* HttpClientResponse.schemaBodyJson(FolderListing)(
      yield* get("/api/folders"),
    );
    assert.strictEqual(listing.path, dir);
    assert.strictEqual(listing.home, dir);
  }).pipe(Effect.provide(withStored)),
);

/** The data of the first Server-Sent Event in the response, decoded. */
const firstEvent = <A>(response: HttpClientResponse.HttpClientResponse, schema: Schema.Codec<A>) =>
  response.stream.pipe(
    Stream.decodeText(),
    Stream.mapAccum(
      () => "",
      (text, chunk) => {
        const all = text + chunk;
        const end = all.indexOf("\n\n");
        return end < 0 ? [all, []] : ["", [all.slice(0, end)]];
      },
    ),
    Stream.runHead,
    Effect.map((event) => /^data: (.*)$/m.exec(Option.getOrElse(event, () => ""))?.[1] ?? ""),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
  );

it.effect("tells whether NW.js is downloaded, and what a game's page follows", () =>
  Effect.gen(function* () {
    const nwjs = yield* get("/api/nwjs");
    assert.strictEqual(nwjs.headers["content-type"], "text/event-stream");
    assert.deepInclude(yield* firstEvent(nwjs, ProgramStatus), {
      version: "v0.117.0",
      phase: { _tag: "Missing" },
    });
    const activity = yield* get(`/api/activity?id=${game.id}`);
    assert.strictEqual(activity.headers["content-type"], "text/event-stream");
    assert.deepInclude(yield* firstEvent(activity, GameActivity), {
      launch: null,
      translation: null,
      images: null,
      importing: null,
    });
    assert.deepStrictEqual(yield* refusal(yield* get("/api/activity?id=ffffffffffffffffffff")), [
      400,
      { _tag: "GameNotInspected" },
    ]);
  }).pipe(Effect.provide(withStored)),
);

it.effect(
  "a game without a translation run has no status, and one not inspected can't start one",
  () =>
    Effect.gen(function* () {
      assert.isNull(yield* (yield* get(`/api/translate?id=${game.id}`)).json);
      assert.deepStrictEqual(
        yield* refusal(
          yield* post("/api/translate", { id: "ffffffffffffffffffff", kind: "translate" }),
        ),
        [400, { _tag: "GameNotInspected" }],
      );
      assert.isNull(yield* (yield* post("/api/translate/stop", { id: game.id })).json);
      assert.deepStrictEqual(yield* refusal(yield* get("/api/translate?id=ffffffffffffffffffff")), [
        400,
        { _tag: "GameNotInspected" },
      ]);
    }).pipe(Effect.provide(withStored)),
);

it.effect("requests without the token, from another origin or for another host are refused", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* refused(yield* HttpClient.get("/api/games")), [
      403,
      "Reload RPGTL to connect.",
    ]);
    assert.deepStrictEqual(
      yield* refused(
        yield* HttpClient.execute(
          HttpClientRequest.get("/api/games").pipe(
            withToken,
            HttpClientRequest.setHeader("Origin", "http://example.com"),
          ),
        ),
      ),
      [403, "Invalid origin."],
    );
    // Fetch drops a Host header, so these requests go through node:http. The page needs no token,
    // so only the host check refuses it.
    const port = yield* listeningPort;
    for (const address of ["/api/games", "/"]) {
      const rebound = yield* HttpClient.execute(
        HttpClientRequest.get(`http://127.0.0.1:${port}${address}`).pipe(
          withToken,
          HttpClientRequest.setHeader("Host", "rebound.example.com"),
        ),
      ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
      assert.deepStrictEqual(yield* refused(rebound), [403, "Invalid host."]);
    }
  }).pipe(Effect.provide(withStored)),
);

const report = (id: string, body: unknown, from?: string) =>
  HttpClientRequest.post(`/playtime/${id}`).pipe(
    from === undefined ? (request) => request : HttpClientRequest.setHeader("Origin", from),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(HttpClient.execute),
    Effect.map((response) => response.status),
  );

it.effect("a game played in the browser adds to its playtime, from RPGTL's origin only", () =>
  Effect.gen(function* () {
    const origin = `http://127.0.0.1:${yield* listeningPort}`;
    assert.deepStrictEqual(yield* (yield* get(`/api/playtime?id=${game.id}`)).json, null);
    assert.strictEqual(yield* report(game.id, { seconds: 30 }), 403);
    assert.strictEqual(yield* report(game.id, { seconds: 30 }, "http://example.com"), 403);
    assert.strictEqual(yield* report(game.id, { seconds: 0 }, origin), 400);
    assert.strictEqual(yield* report("missing", { seconds: 30 }, origin), 404);
    assert.strictEqual(yield* report(game.id, { seconds: 30 }, origin), 204);
    const playtime = yield* HttpClientResponse.schemaBodyJson(Playtime)(
      yield* get(`/api/playtime?id=${game.id}`),
    );
    assert.strictEqual(playtime.seconds, 30);
  }).pipe(Effect.provide(withStored)),
);

it.effect("serves the page at each of its addresses, and only the files it was built with", () =>
  Effect.gen(function* () {
    for (const address of ["/", `/games/${game.id}`, "/settings"]) {
      const page = yield* HttpClient.get(address);
      assert.strictEqual(page.headers["content-type"], "text/html; charset=utf-8", address);
      assert.include(yield* page.text, `<meta name="rpgtl-token" content="${token}" />`);
    }
    const html = yield* (yield* HttpClient.get("/")).text;
    const script = /<script[^>]* src="([^"]+)"/.exec(html)?.[1] ?? "";
    const built = yield* HttpClient.get(script);
    assert.strictEqual(built.headers["content-type"], "text/javascript; charset=utf-8");
    assert.strictEqual((yield* HttpClient.get("/style.css")).status, 404);
    assert.strictEqual((yield* HttpClient.get("/assets/missing.js")).status, 404);
    assert.strictEqual((yield* HttpClient.get("/api/missing")).status, 404);
  }).pipe(Effect.provide(withStored)),
);

it.effect("plays an inspected game's files under /game/", () =>
  Effect.gen(function* () {
    const dir = yield* folderWith(mvGame);
    const { game: played } = yield* (yield* post("/api/inspect", {
      path: dir,
      choice: "keepBoth",
    })).json.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Struct({ game: Schema.Struct({ id: Schema.String }) })),
      ),
    );
    // Fetch follows redirects, so this request goes through node:http.
    const redirect = yield* HttpClient.get(
      `http://127.0.0.1:${yield* listeningPort}/game/${played.id}?x=1`,
    ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
    assert.deepStrictEqual(
      [redirect.status, redirect.headers.location],
      [302, `/game/${played.id}/`],
    );
    const index = yield* HttpClient.get(`/game/${played.id}/`);
    assert.strictEqual(index.headers["cache-control"], "no-store");
    assert.include(yield* index.text, `<script src="/runtime.js" data-game="${played.id}">`);
    // A newly opened game plays as it is until its translation switch is on.
    const untouched = yield* HttpClient.get(`/game/${played.id}/data/Map001.json`);
    assert.strictEqual(untouched.headers["content-type"], "application/json");
    yield* post("/api/catalog/translate", { id: played.id, on: true });
    const map = yield* HttpClient.get(`/game/${played.id}/data/Map001.json`);
    assert.strictEqual(map.headers["content-type"], "application/json; charset=utf-8");
    const face = yield* HttpClient.get(`/game/${played.id}/img/faces/Actor1.png`);
    assert.deepStrictEqual([face.status, face.headers["content-type"]], [200, "image/png"]);
    assert.strictEqual((yield* HttpClient.get(`/game/${played.id}/missing.png`)).status, 404);
    assert.strictEqual((yield* HttpClient.get(`/game/ffffffffffffffffffff/`)).status, 404);
    assert.strictEqual(
      (yield* HttpClient.get(`/erased/${played.id}/${"0".repeat(64)}.png`)).status,
      404,
    );
  }).pipe(Effect.provide(withStored)),
);
