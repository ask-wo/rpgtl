import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { gameFiles } from "@rpgtl/contracts";
import { writeArchive } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { PNG } from "pngjs";
import * as Catalogs from "../games/Catalogs.ts";
import * as StateFolder from "../state/StateFolder.ts";
import { greyPng } from "../testUtils/png.ts";
import { servicesWith } from "../testUtils/state.ts";
import { translatedSign } from "../testUtils/xpImages.ts";
import * as XpImages from "./XpImages.ts";

const services = XpImages.layer.pipe(
  Layer.provideMerge(servicesWith({})),
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "an XP game's translated image becomes tiles, drawn again only when its English changes",
  () =>
    Effect.gen(function* () {
      const xpImages = yield* XpImages.XpImages;
      const catalogs = yield* Catalogs.Catalogs;
      const folder = yield* StateFolder.StateFolder;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const game = yield* translatedSign("Exit");
      const drawn = yield* xpImages.drawn(game);
      const [first, ...others] = drawn;
      assert.isEmpty(others);
      assert.strictEqual(first?.image, "Graphics/Pictures/Sign");
      assert.match(first?.tiles ?? "", /^Graphics\/RPGTL\/[0-9a-f]{64}$/);
      const places = first?.places ?? [];
      assert.isNotEmpty(places);
      const tiles = PNG.sync.read(Buffer.from(first?.bytes ?? new Uint8Array()));
      for (let at = 0; at < places.length; at += 5) {
        const [x = 0, y = 0, top = 0, width = 0, height = 0] = places.slice(at, at + 5);
        assert.isTrue(x + width <= 64 && y + height <= 32 && top + height <= tiles.height);
      }
      const red = Array.from({ length: tiles.width * tiles.height }, (_, at) =>
        tiles.data.subarray(at * 4, at * 4 + 4),
      ).some(([r = 0, g = 0, , a = 0]) => r > 200 && g < 80 && a > 200);
      assert.isTrue(red, "the English is drawn in its red");

      const cached = gameFiles(game.id).letteredImages;
      assert.lengthOf(yield* folder.list(cached), 2);
      assert.deepStrictEqual(yield* xpImages.drawn(game), drawn);

      const catalog = yield* catalogs.get(game.id);
      yield* catalogs.save({
        ...catalog,
        entries: catalog.entries.map((entry) => ({ ...entry, translation: { user: "Way out" } })),
      });
      const [redrawn] = yield* xpImages.drawn(game);
      assert.notStrictEqual(redrawn?.tiles, first?.tiles);
      assert.sameMembers(
        [...(yield* folder.list(cached))],
        [`${redrawn?.tiles.split("/").at(-1)}.png`, `${redrawn?.tiles.split("/").at(-1)}.json`],
      );

      // A game update that changes the image leaves it untranslated instead of laying the tiles
      // drawn for the old one over it.
      yield* fs.writeFile(
        path.join(game.root, "Game.rgssad"),
        writeArchive(new Map([["Graphics/Pictures/Sign.png", greyPng(64, 32, [[1, 1]])]])),
      );
      assert.isEmpty(yield* xpImages.drawn(game));
    }).pipe(Effect.provide(services)),
);
