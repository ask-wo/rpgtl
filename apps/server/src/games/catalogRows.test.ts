import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Catalog, Location, OperationKind, Text } from "@rpgtl/contracts";
import { cleared, newEntry, withTexts, withTextOf, withUserTranslation } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import { game, servicesWith } from "../testUtils/state.ts";
import {
  readCatalog,
  startOperation,
  writeChanged,
  writeInspected,
  writeRunChanges,
} from "./catalogRows.ts";
import * as GameDatabases from "./GameDatabases.ts";

const services = servicesWith({}).pipe(Layer.provideMerge(NodeServices.layer));

const header: Catalog["game"] = { id: game.id, title: "Test Game", engine: "MV" };
const message = (index: number): Location => ({
  _tag: "Message",
  list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
  index,
});
const read = (index: number, source: string) => ({
  ...newEntry(message(index), source),
  isInImage: false,
});

const inDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(GameDatabases.GameDatabases, (databases) => databases.use(game.id, effect));

const readBack = readCatalog(header).pipe(
  Effect.filterOrElse(Predicate.isNotUndefined, () => Effect.die(new Error("no catalog"))),
);

it.effect("reading the game shares a text among the lines that read the same", () =>
  inDatabase(
    Effect.gen(function* () {
      assert.isUndefined(yield* readCatalog(header));
      const operation = yield* startOperation("inspection");
      yield* writeInspected([read(0, "你好"), read(1, "再见"), read(2, "你好")], operation);
      const catalog = yield* readBack;
      assert.deepStrictEqual(
        catalog.texts.map(({ source }) => source),
        ["你好", "再见"],
      );
      assert.deepStrictEqual(
        catalog.entries.map(({ textId }) => textId),
        [1, 2, 1],
      );
      assert.deepStrictEqual(
        catalog.operations.map(({ kind }) => kind),
        ["inspection"],
      );
    }),
  ).pipe(Effect.provide(services)),
);

it.effect("a line that moved keeps the English of its text when the game is read again", () =>
  inDatabase(
    Effect.gen(function* () {
      yield* writeInspected([read(0, "走吧"), read(1, "好")], yield* startOperation("inspection"));
      const first = yield* readBack;
      const translated = withTexts(first, (text) =>
        text.source === "走吧" ? { ...text, userTranslation: "Let's go" } : text,
      );
      yield* writeChanged(first, translated, yield* startOperation("edit"));
      yield* writeInspected([read(5, "走吧")], yield* startOperation("inspection"));
      const again = yield* readBack;
      assert.deepStrictEqual(
        again.entries.map(({ id }) => id),
        [read(5, "走吧").id],
      );
      assert.strictEqual(again.texts[0]?.userTranslation, "Let's go");
    }),
  ).pipe(Effect.provide(services)),
);

it.effect(
  "written changes read back, with the run that wrote each model translation and the English cleared",
  () =>
    inDatabase(
      Effect.gen(function* () {
        yield* writeInspected(
          [read(0, "你好"), read(1, "雨")],
          yield* startOperation("inspection"),
        );
        const first = yield* readBack;
        const run = yield* startOperation("run", {
          translator: "codex",
          model: "terra",
          glossaryModel: "sol",
        });
        yield* writeRunChanges(
          {
            texts: [{ id: 1, modelTranslation: "Hello" }],
            terms: [{ id: -1, source: "雨", modelTranslation: "Rain", rulesKind: "word" }],
          },
          run,
        );
        const translated = yield* readBack;
        assert.deepStrictEqual(translated.texts[0], {
          id: 1,
          source: "你好",
          isInImage: false,
          modelTranslation: "Hello",
          modelOperationId: run,
        });
        assert.deepStrictEqual(translated.glossary, [
          {
            id: 1,
            source: "雨",
            modelTranslation: "Rain",
            modelOperationId: run,
            rulesKind: "word",
          },
        ]);
        const added = withTextOf(translated, { source: "开始", isInImage: true });
        const next = {
          ...withTexts(added.catalog, (text) => (text.id === 1 ? cleared(text) : text)),
          entries: [
            ...translated.entries,
            {
              id: "image",
              textId: added.id,
              location: { _tag: "ImageLines" as const, image: "img/pictures/Sign", lines: [0] },
            },
          ],
          glossary: [],
          settings: {
            ...translated.settings,
            isTranslationOn: true,
            letteringFont: "serif" as const,
          },
        };
        yield* writeChanged(translated, next, yield* startOperation("clear"));
        const after = yield* readBack;
        assert.deepStrictEqual(after.texts, [
          { id: 1, source: "你好", isInImage: false, previousTranslation: "Hello" },
          { id: 2, source: "雨", isInImage: false },
          { id: 3, source: "开始", isInImage: true },
        ]);
        assert.deepStrictEqual(after.entries.at(-1)?.textId, 3);
        assert.deepStrictEqual(after.glossary, []);
        assert.deepStrictEqual(after.settings, next.settings);
        assert.strictEqual(first.entries.length + 1, after.entries.length);
      }),
    ).pipe(Effect.provide(services)),
);

it.effect(
  "a text keeps the English from before it was cleared, also by the user, until that English is in use again",
  () =>
    inDatabase(
      Effect.gen(function* () {
        yield* writeInspected([read(0, "你好")], yield* startOperation("inspection"));
        const typed = Effect.fn("test.typed")(function* (english: string) {
          const before = yield* readBack;
          const next = withTexts(before, (text) => ({ ...text, userTranslation: english }));
          yield* writeChanged(before, next, yield* startOperation("edit"));
          return (yield* readBack).texts[0]?.previousTranslation;
        });
        yield* typed("Hello");
        const before = yield* readBack;
        yield* writeChanged(before, withTexts(before, cleared), yield* startOperation("clear"));
        assert.strictEqual(yield* typed("Hi"), "Hello");
        assert.isUndefined(yield* typed("Hello"));
        yield* typed("Hello there");
        const typedOver = yield* readBack;
        yield* writeChanged(
          typedOver,
          withTexts(typedOver, cleared),
          yield* startOperation("edit"),
        );
        assert.strictEqual((yield* readBack).texts[0]?.previousTranslation, "Hello there");
      }),
    ).pipe(Effect.provide(services)),
);

it.effect("Use it clears nothing, and English the user cleared stays previous through a run", () =>
  inDatabase(
    Effect.gen(function* () {
      yield* writeInspected([read(0, "你好")], yield* startOperation("inspection"));
      const write = Effect.fn("test.write")(function* (
        kind: OperationKind,
        f: (text: Text) => Text,
      ) {
        const before = yield* readBack;
        yield* writeChanged(before, withTexts(before, f), yield* startOperation(kind));
        return (yield* readBack).texts[0]?.previousTranslation;
      });
      yield* write("run", (text) => ({ ...text, modelTranslation: "Hello" }));
      yield* write("edit", (text) => ({ ...text, userTranslation: "Hi" }));
      assert.isUndefined(yield* write("edit", (text) => withUserTranslation(text, "Hello")));
      assert.strictEqual(yield* write("edit", cleared), "Hello");
      assert.strictEqual(
        yield* write("run", (text) => ({ ...text, modelTranslation: "Hey" })),
        "Hello",
      );
    }),
  ).pipe(Effect.provide(services)),
);
