import { gameFiles } from "@rpgtl/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ImageReadResults, ImageResult } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { servicesWith, StateDir } from "../testUtils/state.ts";
import * as ImageTexts from "./ImageTexts.ts";

const services = servicesWith({}).pipe(Layer.provideMerge(NodeServices.layer));
const id = "0123456789abcdef0123";

const result = (erased?: string): ImageResult => ({
  file: "img/pictures/Notice.png",
  sha256: "",
  width: 10,
  height: 10,
  lines: [],
  ...(erased !== undefined && { erased }),
});

it.effect("an export carries the results and the erased backgrounds they use, and comes back", () =>
  Effect.gen(function* () {
    const imageTexts = yield* ImageTexts.ImageTexts;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    assert.isTrue(Option.isNone(yield* imageTexts.exported(id)));

    const kept = yield* imageTexts.saveErased(id, new Uint8Array([1, 2]));
    const unused = yield* imageTexts.saveErased(id, new Uint8Array([3]));
    assert.match(kept, /^[0-9a-f]{64}\.png$/);
    const results: ImageReadResults = {
      version: 1,
      images: { "img/pictures/Notice": result(kept) },
    };
    yield* imageTexts.save(id, results);
    yield* imageTexts.removeUnused(id);
    const folder = path.join(yield* StateDir, gameFiles(id).erasedImages);
    assert.deepStrictEqual(yield* fs.readDirectory(folder), [kept]);
    assert.notStrictEqual(kept, unused);

    const exported = Option.getOrThrow(yield* imageTexts.exported(id));
    assert.deepStrictEqual(exported, {
      results,
      erased: new Map([[kept, new Uint8Array([1, 2])]]),
    });
    yield* imageTexts.clear(id);
    assert.isFalse(yield* fs.exists(folder));
    assert.deepStrictEqual(yield* imageTexts.results(id), { version: 1, images: {} });

    yield* imageTexts.replace(id, exported);
    assert.deepStrictEqual(yield* imageTexts.exported(id), Option.some(exported));
  }).pipe(Effect.provide(services)),
);
