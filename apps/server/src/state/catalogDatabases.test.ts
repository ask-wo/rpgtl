import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { gameFiles } from "@rpgtl/contracts";
import { entryTexts, operationsById } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readCatalogAt } from "../games/catalogRows.ts";
import * as StateFolder from "./StateFolder.ts";

const format2 = new URL("formats/2", import.meta.url).pathname;
const id = "4d6f73734c616e746572";

it.effect(
  "a catalog file becomes the game's database, each English kept with the run that gave it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* fs.copy(format2, dir);
      const state = path.join(dir, "state");
      yield* Effect.flatMap(StateFolder.StateFolder, (folder) => folder.list("games")).pipe(
        Effect.provide(StateFolder.layerAt(state)),
      );
      assert.isFalse(yield* fs.exists(path.join(state, gameFiles(id).catalog)));
      const catalog = yield* readCatalogAt(path.join(state, gameFiles(id).database), {
        id,
        title: "",
        engine: "MV",
      });
      assert(catalog);
      const operations = operationsById(catalog);
      const runOf = (operationId: number | undefined) =>
        operationId === undefined ? undefined : operations.get(operationId)?.startedAt;

      const [said, sign, fight] = entryTexts(catalog);
      assert.include(said, {
        modelTranslation: "\\N[1], the lamp oil is nearly gone.",
        flagReason: "The speaker may be wrong.",
        userTranslation: "\\N[1], the lamp is almost out of oil.",
        previousTranslation: "\\N[1], the oil runs low.",
        speaker: "艾芙",
      });
      assert.strictEqual(runOf(said?.modelOperationId), "2026-11-01T10:00:00.000Z");
      assert.include(sign, {
        source: "苔灯",
        modelTranslation: "Moss Lamp",
        unshortenedTranslation: "The Moss Lantern",
      });
      assert.include(fight, {
        rejectedTranslation: "战斗 Fight",
        rejectionReason: "source text left",
      });

      const [eve, lamp] = catalog.glossary;
      assert.include(eve, {
        modelTranslation: "Ive",
        userTranslation: "Eve",
        rulesKind: "character",
        modelKind: "character",
        rulesPronoun: "she",
        sheClues: 4,
        heClues: 1,
        userPronoun: "she",
      });
      assert.strictEqual(runOf(eve?.modelOperationId), "2026-11-01T09:00:00.000Z");
      assert.include(lamp, { userKind: "word", previousTranslation: "Moss Lamp" });

      assert.deepInclude(catalog.settings, {
        isTranslationOn: true,
        isScriptTranslationOn: false,
        disabledFixes: ["battle-history.rb"],
        sourceLanguage: "chinese",
        letteringWeight: "regular",
        letteringFont: "serif",
        untranslatedImages: ["img/pictures/Notice"],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("copies of one text that had different English keep the user's and the run's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.copy(format2, dir);
    const state = path.join(dir, "state");
    const file = path.join(state, gameFiles(id).catalog);
    const saved = JSON.parse(yield* fs.readFileString(file));
    const sign = saved.entries[1];
    yield* fs.writeFileString(
      file,
      JSON.stringify({
        ...saved,
        entries: [
          ...saved.entries,
          {
            ...sign,
            id: "e4",
            location: { ...sign.location, lines: [1] },
            translation: { user: "Moss Light" },
          },
        ],
      }),
    );
    yield* Effect.flatMap(StateFolder.StateFolder, (folder) => folder.list("games")).pipe(
      Effect.provide(StateFolder.layerAt(state)),
    );
    const catalog = yield* readCatalogAt(path.join(state, gameFiles(id).database), {
      id,
      title: "",
      engine: "MV",
    });
    assert(catalog);
    const copies = entryTexts(catalog).filter((entry) => entry.source === "苔灯");
    assert.lengthOf(copies, 2);
    for (const copy of copies)
      assert.include(copy, { modelTranslation: "Moss Lamp", userTranslation: "Moss Light" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
