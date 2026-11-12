import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import {
  type Catalog,
  type Entry,
  type Location,
  RunLogLine,
  type RunStatus,
  type Settings,
  gameFiles,
  runEnded,
} from "@rpgtl/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Catalogs from "../games/Catalogs.ts";
import * as Games from "../games/Games.ts";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import { game, runServices, servicesWith, StateDir } from "../testUtils/state.ts";
import * as Ollama from "../localModels/Ollama.ts";
import * as RunKinds from "../runs/RunKinds.ts";
import * as SavedSettings from "../settings/Settings.ts";
import * as Runs from "./Runs.ts";
import { entryTranslation, termTranslation } from "@rpgtl/domain";

const entry = (id: string, location: Location, source: string): Entry => ({
  id,
  location,
  source,
  translation: {},
});
const dialogue = (id: string, index: number, source: string) =>
  entry(
    id,
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index },
    source,
  );

const catalog: Catalog = {
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  translate: true,
  entries: [
    entry("actor", { _tag: "RecordField", table: "actors", record: 1, field: "name" }, "艾琳"),
    dialogue("hello", 0, "你好"),
    dialogue("arrives", 1, "艾琳来了"),
  ],
  glossary: [],
};

const english: Record<string, string> = {
  艾琳: "Arlene",
  你好: "Hello",
  艾琳来了: "Arlene is here",
};

/** The saved settings the runs read: Ollama with the model the fake Ollama answers as. */
const qwenSettings = { translation: { translator: "ollama", ollama: { model: "qwen" } } };

/** Saves the Ollama settings that the runs started next read. */
const chooseOllama = Effect.fnUntraced(function* (ollama: Partial<Settings["ollama"]>) {
  const settings = yield* SavedSettings.Settings;
  const now = yield* settings.get;
  yield* settings.save({ ...now, ollama: { ...now.ollama, ...ollama } });
});

/**
 * How the fake Ollama answers a translation request: with `english` unless `answer` gives the
 * reply's text, or fails it with an HTTP status.
 */
type Answer = (
  sources: ReadonlyArray<string>,
  temperature: number | undefined,
  request: typeof Chat.Type,
) => Effect.Effect<Option.Option<string | number>>;

const Chat = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ content: Schema.String })),
  think: Schema.optionalKey(Schema.Boolean),
  options: Schema.optionalKey(
    Schema.Struct({
      temperature: Schema.optionalKey(Schema.Finite),
      num_predict: Schema.optionalKey(Schema.Finite),
    }),
  ),
});
const TranslationRequest = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  }),
);

class Answers extends Context.Service<Answers, Ref.Ref<Answer>>()(
  "@rpgtl/server/translation/Answers",
) {}

/** The models the fake Ollama was asked to unload, in order. */
class Unloaded extends Context.Service<Unloaded, Ref.Ref<ReadonlyArray<string>>>()(
  "@rpgtl/server/translation/Unloaded",
) {}

const Unload = Schema.Struct({ model: Schema.String, keep_alive: Schema.Literal(0) });

/** Ollama on a fake server that answers each request the way `Answers` holds. */
const fakeOllama = Layer.unwrap(
  Effect.gen(function* () {
    const answer = yield* Answers;
    const unloaded = yield* Unloaded;
    return httpClientAnswering((url, body) =>
      Effect.gen(function* () {
        if (url.pathname === "/api/generate") {
          const { model } = yield* Schema.decodeUnknownEffect(Unload)(body).pipe(Effect.orDie);
          yield* Ref.update(unloaded, (models) => [...models, model]);
        }
        // A model without its layer count, so llama-server can keep no expert layers in RAM.
        if (url.pathname === "/api/show")
          return Option.some(
            Response.json({ modelfile: "FROM /models/qwen.gguf\n", model_info: {} }),
          );
        if (url.pathname !== "/api/chat") return Option.some(Response.json({ models: [] }));
        const chat = yield* Schema.decodeUnknownEffect(Chat)(body).pipe(Effect.orDie);
        const { messages, options } = chat;
        // A question about a term's kind or a character's pronoun gets an answer that doesn't fit,
        // which the run carries on without.
        const entries = Option.match(
          Schema.decodeUnknownOption(TranslationRequest)(messages.at(-1)?.content),
          { onNone: () => [], onSome: (request) => request.entries },
        );
        const given = yield* Effect.flatMap(Ref.get(answer), (answerOf) =>
          answerOf(
            entries.map(({ text }) => text),
            options?.temperature,
            chat,
          ),
        );
        if (Option.isSome(given) && typeof given.value === "number")
          return Option.some(new Response("overloaded", { status: given.value }));
        const content = Option.getOrElse(
          Option.filter(given, (text) => typeof text === "string"),
          () =>
            JSON.stringify(
              Object.fromEntries(entries.map(({ id, text }) => [id, english[text] ?? "{}"])),
            ),
        );
        return Option.some(
          Response.json({ message: { content }, done_reason: "stop", eval_count: 5 }),
        );
      }),
    );
  }),
);

/** The run services over a state folder holding the game, its catalog and `files`. */
const runServicesWith = (files: Record<string, string> = {}) =>
  runServices.pipe(
    Layer.provideMerge(Ollama.layer),
    Layer.provideMerge(fakeOllama),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(
          Answers,
          Ref.make<Answer>(() => Effect.succeedNone),
        ),
        Layer.effect(Unloaded, Ref.make<ReadonlyArray<string>>([])),
      ),
    ),
    Layer.provideMerge(
      servicesWith({
        "games.json": JSON.stringify([game]),
        [gameFiles(game.id).catalog]: JSON.stringify(catalog),
        "config/rpgtl/settings.json": JSON.stringify(qwenSettings),
        ...files,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const Services = runServicesWith();

/** Waits for the game's run to end, and gives its last status. */
const ended = (runs: Runs.Runs["Service"]) =>
  Stream.unwrap(runs.changes(game.id)).pipe(
    Stream.filter(Option.isSome),
    Stream.map((run) => run.value),
    Stream.filter((status) => runEnded(status.phase)),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
  );

const translations = Effect.gen(function* () {
  const catalogs = yield* Catalogs.Catalogs;
  const { entries } = yield* catalogs.get(game.id);
  return Object.fromEntries(entries.map((saved) => [saved.id, entryTranslation(saved)]));
});

const logLines = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const logs = path.join(yield* StateDir, gameFiles(game.id).logs);
  const [file] = (yield* fs.readDirectory(logs)).filter((name) => name.includes("translation"));
  const text = yield* fs.readFileString(path.join(logs, file ?? ""));
  // Each line must fit the schema the audit and the comparison read.
  return text
    .trim()
    .split("\n")
    .map((line) => Schema.decodeSync(Schema.fromJsonString(RunLogLine))(line));
});

layer(Services)((it) => {
  it.effect(
    "a run translates names into the glossary first, then the text, and logs each request",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        yield* Ref.set(yield* Answers, () => Effect.succeedNone);
        const first = yield* runs.start(game.id, "translate");
        assert.deepInclude(first, {
          kind: "translate",
          phase: { _tag: "Running" },
          total: 3,
          done: 0,
          left: 3,
        });

        const last = yield* ended(runs);
        assert.deepInclude(last, {
          phase: { _tag: "Finished" },
          done: 3,
          translated: 3,
          left: 0,
        });
        assert.deepStrictEqual(yield* translations, {
          actor: "Arlene",
          hello: "Hello",
          arrives: "Arlene is here",
        });
        const { glossary } = yield* (yield* Catalogs.Catalogs).get(game.id);
        assert.deepStrictEqual(
          glossary.map((term) => [term.source, termTranslation(term)]),
          [["艾琳", "Arlene"]],
        );

        const lines = yield* logLines;
        assert.include(lines[0], { type: "run", translator: "ollama", model: "qwen", entries: 3 });
        const requests = lines.filter((line) => line.type === "request");
        // The dialogue request names Arlene from the glossary the glossary pass filled.
        const text = requests.find((line) => line.entryIds.includes("arrives"));
        assert.include(text?.request.messages.at(-1)?.content, '"translation":"Arlene"');
        assert.include(lines.at(-1), { type: "end", translated: 3, stopped: false });

        // The catalog keeps what the run used under the start time its entries name.
        const saved = yield* (yield* Catalogs.Catalogs).get(game.id);
        const started = lines[0]?.type === "run" ? lines[0].started : "";
        assert.deepStrictEqual(saved.runs, {
          [started]: {
            translator: "ollama",
            model: "qwen",
            glossaryModel: "qwen",
            numCtx: 4096,
            sampling: "temperature-0",
            retrySampling: "model",
            effort: "off",
          },
        });
        assert.strictEqual(saved.glossary[0]?.translation.guess?.run, started);
        assert.strictEqual(saved.entries[0]?.translation.guess?.run, started);

        // The game is free again once the run ended.
        yield* (yield* Games.Games).exclusive(game.id, Effect.void);
      }),
  );
});

layer(Services)((it) => {
  it.effect(
    "answers that fail their checks are asked again alone with the model's own sampling, and those that still fail are listed",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        const temperatures: Array<number | undefined> = [];
        // Answers in Chinese fail their checks, both in the batch and alone.
        yield* Ref.set(yield* Answers, (sources, temperature) =>
          Effect.sync(() => {
            if (sources.includes("你好")) temperatures.push(temperature);
          }).pipe(
            Effect.as(
              sources.includes("你好")
                ? Option.some(
                    JSON.stringify(
                      Object.fromEntries(
                        sources.map((source, index) => [
                          String(index + 1),
                          source === "你好" ? "你好" : (english[source] ?? ""),
                        ]),
                      ),
                    ),
                  )
                : Option.none(),
            ),
          ),
        );
        yield* runs.start(game.id, "translate");
        const last = yield* ended(runs);
        assert.deepStrictEqual(last.failed, ["hello"]);
        assert.deepStrictEqual(temperatures, [0, undefined]);
        assert.include(last, { done: 2, left: 0 });
        assert.include(yield* translations, {
          actor: "Arlene",
          hello: "",
          arrives: "Arlene is here",
        });
        const asked = (yield* logLines)
          .filter((line) => line.type === "request")
          .map((line) => line.entryIds.join(","));
        assert.deepStrictEqual(asked.slice(-2), ["hello,arrives", "hello"]);
      }),
  );
});

layer(Services)((it) => {
  it.effect(
    "a game's changes say it has no run until one starts, then follow that run while it ends",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        yield* Ref.set(yield* Answers, () => Effect.succeedNone);
        const opened = yield* Deferred.make<void>();
        const following = yield* Stream.unwrap(runs.changes(game.id)).pipe(
          Stream.tap(() => Deferred.succeed(opened, undefined)),
          Stream.takeUntil((run) => Option.isSome(run) && runEnded(run.value.phase)),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(opened);
        yield* runs.start(game.id, "translate");
        const seen = yield* Fiber.join(following);
        assert.deepStrictEqual(seen[0], Option.none());
        assert.deepInclude(Option.getOrUndefined(seen.at(-1) ?? Option.none<RunStatus>()), {
          phase: { _tag: "Finished" },
          done: 3,
        });
        const phases = seen.flatMap((run) => (Option.isSome(run) ? [run.value.phase._tag] : []));
        assert.deepStrictEqual(phases.slice(phases.indexOf("Ending")), ["Ending", "Finished"]);
      }),
  );
});

layer(Services)((it) => {
  it.effect("stopping a run keeps what it saved and frees the game", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      const asked = yield* Deferred.make<void>();
      yield* Ref.set(yield* Answers, (sources) =>
        sources.includes("你好")
          ? Deferred.succeed(asked, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeedNone,
      );
      yield* runs.start(game.id, "translate");
      yield* Deferred.await(asked);
      const stopped = yield* runs.stop(game.id);
      assert.isTrue(Option.isSome(stopped));
      assert.deepInclude(Option.getOrThrow(stopped), { phase: { _tag: "Stopped" }, done: 1 });
      assert.include(yield* translations, { actor: "Arlene", hello: "" });
      assert.include((yield* logLines).at(-1), { type: "end", stopped: true, translated: 1 });
      yield* (yield* Games.Games).exclusive(game.id, Effect.void);
    }),
  );
});

layer(Services)((it) => {
  it.effect("a Stop sent while the run is still starting stops it", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      const [, stopped] = yield* Effect.all(
        [runs.start(game.id, "translate"), runs.stop(game.id)],
        {
          concurrency: "unbounded",
        },
      );
      assert.deepInclude(Option.getOrThrow(stopped), { phase: { _tag: "Stopped" } });
      assert.include(yield* translations, { actor: "" });
      yield* (yield* Games.Games).exclusive(game.id, Effect.void);
    }),
  );
});

layer(Services)((it) => {
  it.effect("a request that fails ends the run with a message, keeping what was saved", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      yield* Ref.set(yield* Answers, (sources) =>
        Effect.succeed(sources.includes("你好") ? Option.some(500) : Option.none()),
      );
      yield* runs.start(game.id, "translate");
      const last = yield* ended(runs);
      assert.include(last, { done: 1 });
      const error = last.phase._tag === "Failed" ? last.phase.error : "";
      assert.notStrictEqual(error, "");
      assert.include(yield* translations, { actor: "Arlene", hello: "" });
      const end = (yield* logLines).at(-1);
      assert.include(end, { type: "end", error });
    }),
  );
});

layer(Services)((it) => {
  it.effect("with thinking on, Ollama thinks without the answer's cap, at temperature 0", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      const settings = yield* SavedSettings.Settings;
      const now = yield* settings.get;
      yield* settings.save({
        ...now,
        translation: {
          ...now.translation,
          ollama: { ...now.translation.ollama, effort: "on" },
        },
      });
      const asked: Array<typeof Chat.Type> = [];
      yield* Ref.set(yield* Answers, (sources, _temperature, request) =>
        Effect.sync(() => {
          if (sources.length > 0) asked.push(request);
        }).pipe(Effect.as(Option.none())),
      );
      yield* runs.start(game.id, "translate");
      yield* ended(runs);
      assert.isNotEmpty(asked);
      for (const request of asked) {
        assert.strictEqual(request.think, true);
        assert.deepStrictEqual(request.options, { temperature: 0 });
      }
    }),
  );
});

layer(Services)((it) => {
  it.effect("a placement llama-server can't run ends the run saying what to change", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      yield* chooseOllama({ runner: "llama-server", minExpertLayersInRam: 33 });
      yield* runs.start(game.id, "translate");
      const last = yield* ended(runs);
      assert.deepInclude(last, {
        done: 0,
        phase: {
          _tag: "Failed",
          error: "qwen has 0 layers, so at most 0 can keep their experts in system RAM.",
        },
      });
      assert.deepStrictEqual(yield* translations, { actor: "", hello: "", arrives: "" });
    }),
  );
});

layer(Services)((it) => {
  it.effect(
    "a run waits while image reading runs, and a game another operation holds refuses it",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        const games = yield* Games.Games;
        const runKinds = yield* RunKinds.RunKinds;
        const harbor = { id: "harbor", title: "Harbor Tales" };
        const reading = yield* Scope.make();
        yield* Scope.provide(runKinds.imageReading(harbor), reading);
        const waiting = yield* runs.start(game.id, "translate");
        assert.deepStrictEqual(waiting.phase, {
          _tag: "Waiting",
          for: [{ kind: "imageReading", game: harbor }],
        });
        assert.strictEqual(
          (yield* Effect.flip(runs.start(game.id, "translate")))._tag,
          "GameBusyError",
        );
        // A waiting game isn't held, but stays listed.
        yield* Effect.scoped(games.hold(game.id));
        assert.strictEqual((yield* Effect.flip(games.forget(game.id)))._tag, "GameBusyError");
        yield* Scope.close(reading, Exit.void);
        assert.deepInclude(yield* ended(runs), { done: 3, phase: { _tag: "Finished" } });

        const busy = yield* Effect.flip(games.exclusive(game.id, runs.start(game.id, "translate")));
        assert.strictEqual(busy._tag, "GameBusyError");
      }),
  );
});

layer(Services)((it) => {
  it.effect(
    "an Ollama run waits for another local-model run, with the settings it was asked with",
    () =>
      Effect.gen(function* () {
        const runs = yield* Runs.Runs;
        const runKinds = yield* RunKinds.RunKinds;
        const harbor = { id: "harbor", title: "Harbor Tales" };
        const other = yield* Scope.make();
        yield* Scope.provide(runKinds.translation(harbor, { local: true }), other);
        const waiting = yield* runs.start(game.id, "translate");
        assert.deepStrictEqual(waiting.phase, {
          _tag: "Waiting",
          for: [{ kind: "translation", game: harbor }],
        });
        yield* chooseOllama({ endpoint: "http://192.168.1.5:11434" });
        yield* Scope.close(other, Exit.void);
        assert.deepInclude(yield* ended(runs), { done: 3, phase: { _tag: "Finished" } });
      }),
  );
});

layer(Services)((it) => {
  it.effect("a run on an Ollama endpoint on another computer fails, saying why", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      yield* chooseOllama({ endpoint: "http://192.168.1.5:11434" });
      yield* runs.start(game.id, "translate");
      assert.deepInclude(yield* ended(runs), {
        phase: {
          _tag: "Failed",
          error: "Translation endpoints must be on this computer (127.0.0.1, localhost, or ::1).",
        },
      });
    }),
  );
});

layer(Services)((it) => {
  it.effect("a Build glossary run fills the glossary, leaves the text, and unloads its model", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      yield* runs.start(game.id, "build-glossary");
      const last = yield* ended(runs);
      assert.include(last, { kind: "build-glossary", total: 1, done: 1, left: 0 });
      assert.deepStrictEqual(yield* translations, { actor: "Arlene", hello: "", arrives: "" });
      assert.deepStrictEqual(yield* Ref.get(yield* Unloaded), ["qwen"]);
    }),
  );
});

layer(Services)((it) => {
  it.effect("a run asks in the language chosen for the game", () =>
    Effect.gen(function* () {
      yield* (yield* Catalogs.Catalogs).setLanguage(game.id, "korean");
      const runs = yield* Runs.Runs;
      yield* runs.start(game.id, "build-glossary");
      yield* ended(runs);
      const names = (yield* logLines).find(
        (line) => line.type === "request" && line.entryIds.includes("actor"),
      );
      const system = names?.type === "request" ? names.request.messages[0]?.content : undefined;
      assert.include(system, "Korean person names with the family name first");
      assert.notInclude(system, "Pinyin");
    }),
  );
});

layer(runServicesWith({ [gameFiles(game.id).imageResults]: "not JSON" }))((it) => {
  it.effect("a run that fails before it translates says why and frees the game", () =>
    Effect.gen(function* () {
      const runs = yield* Runs.Runs;
      yield* runs.start(game.id, "translate");
      const last = yield* ended(runs);
      assert.include(last, { done: 0 });
      const error = last.phase._tag === "Failed" ? last.phase.error : "";
      assert.include(error, "images.json");
      assert.include((yield* logLines).at(-1), { type: "end", error });
      yield* (yield* Games.Games).exclusive(game.id, Effect.void);
    }),
  );
});
