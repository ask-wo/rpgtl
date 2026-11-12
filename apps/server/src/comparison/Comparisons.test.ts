import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type Catalog,
  Comparison,
  type ComparisonSetup,
  type Entry,
  gameFiles,
  Samples,
  defaultChoices,
} from "@rpgtl/contracts";
import { pickSamples, entryTranslation } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FreeMemory from "../localModels/FreeMemory.ts";
import * as AgentModels from "../translation/AgentModels.ts";
import * as LlamaServer from "../localModels/LlamaServer.ts";
import * as StateFolder from "../state/StateFolder.ts";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import { game, servicesWith } from "../testUtils/state.ts";
import * as Ollama from "../localModels/Ollama.ts";
import * as Comparisons from "./Comparisons.ts";

const line = (id: string, index: number, source: string): Entry => ({
  id,
  location: { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index },
  source,
  translation: {},
});

const catalog: Catalog = {
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  translate: true,
  entries: [
    line("hello", 0, "你好"),
    line("bye", 1, "再见"),
    // Translated already, and not in the saved sample.
    { ...line("rain", 2, "下雨了"), translation: { user: "It's raining" } },
  ],
  glossary: [],
};

const english: Record<string, string> = { 你好: "Hello", 再见: "Bye" };

const Chat = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({ content: Schema.String })),
});
const TranslationRequest = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  }),
);

/** Ollama where the model `good` translates from `english` and any other is refused. */
const fakeOllama = httpClientAnswering((url, body) =>
  Effect.gen(function* () {
    if (url.pathname !== "/api/chat") return Option.some(Response.json({ models: [] }));
    const { model, messages } = yield* Schema.decodeUnknownEffect(Chat)(body).pipe(Effect.orDie);
    if (model !== "good") return Option.some(Response.json({ error: "no" }, { status: 404 }));
    const entries = Option.match(
      Schema.decodeUnknownOption(TranslationRequest)(messages.at(-1)?.content),
      { onNone: () => [], onSome: (request) => request.entries },
    );
    const content = JSON.stringify(
      Object.fromEntries(entries.map(({ id, text }) => [id, english[text] ?? "{}"])),
    );
    return Option.some(Response.json({ message: { content }, done_reason: "stop", eval_count: 5 }));
  }),
);

const services = () =>
  Comparisons.layer.pipe(
    Layer.provideMerge(LlamaServer.layer),
    Layer.provideMerge(Layer.mergeAll(Ollama.layer, FreeMemory.layer, AgentModels.layer)),
    Layer.provideMerge(fakeOllama),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provideMerge(
      servicesWith({
        "games.json": JSON.stringify([game]),
        [gameFiles(game.id).catalog]: JSON.stringify(catalog),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const ollamaSetup = (model: string): ComparisonSetup => ({
  label: model,
  settings: {
    translator: "ollama",
    endpoint: "http://127.0.0.1:11434",
    ...defaultChoices.ollama,
    model,
    sampling: "temperature-0",
  },
});

it.effect("each setup runs on the saved sample as a run would, and the report shows them all", () =>
  Effect.gen(function* () {
    const comparisons = yield* Comparisons.Comparisons;
    const folder = yield* StateFolder.StateFolder;
    yield* folder.write(gameFiles(game.id).samples, Samples, {
      gameId: game.id,
      groups: [{ label: "Hand-picked", ids: ["hello", "bye"] }],
    });
    const events = yield* Stream.runCollect(
      yield* comparisons.compare(game.id, [ollamaSetup("good"), ollamaSetup("missing")]),
    );
    assert.deepStrictEqual(
      events.map((event) => event._tag),
      ["Started", "Ended", "Started", "Ended"],
    );
    assert.include(events[0], { label: "good", entries: 2 });
    const report = events.at(-1);
    assert(report?._tag === "Ended");
    assert.match(report.report, /reports\/compare-.*\.html$/);
    const html = yield* (yield* FileSystem.FileSystem).readFileString(report.report);
    assert.include(html, "Hello");
    assert.include(html, "2 sample entries to translate,");

    const saved = yield* folder.read(
      report.report.slice(folder.root.length + 1).replace(/\.html$/, ".json"),
      Comparison,
    );
    assert(Option.isSome(saved));
    const [good, missing] = saved.value.setups;
    const goodEnd = good?.lines.at(-1);
    assert(goodEnd?.type === "end");
    assert.include(goodEnd, { translated: 2 });
    assert.deepStrictEqual(goodEnd.failed, []);
    const end = missing?.lines.at(-1);
    assert(end?.type === "end");
    assert.strictEqual(end.translated, 0);
    assert.isString(end.error);
    // The game's own translations stay as they are.
    assert.deepStrictEqual(saved.value.sample.entries.map(entryTranslation), ["", ""]);
  }).pipe(
    Effect.provideService(FreeMemory.NvidiaSmi, "/nowhere/nvidia-smi"),
    Effect.provide(services()),
  ),
);

it.effect("a game without saved samples gets new ones, saved for the next comparison", () =>
  Effect.gen(function* () {
    const comparisons = yield* Comparisons.Comparisons;
    yield* Stream.runDrain(yield* comparisons.compare(game.id, []));
    const saved = yield* (yield* StateFolder.StateFolder).read(gameFiles(game.id).samples, Samples);
    assert.deepStrictEqual(Option.getOrUndefined(saved), pickSamples(catalog));
  }).pipe(Effect.provide(services())),
);
