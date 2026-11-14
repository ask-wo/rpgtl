import { assert, it } from "@effect/vitest";
import { xpImageTable, xpImageTableFile } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PNG } from "pngjs";
import { cachedMkxpz, mkxpzLayer, playXpGame, xvfbRun } from "../testUtils/mkxpz.ts";

/** A PNG of `width` × `height` pixels of one RGBA colour. */
const filled = (width: number, height: number, rgba: readonly [number, number, number, number]) => {
  const png = new PNG({ width, height });
  for (let at = 0; at < width * height; at++) png.data.set(rgba, at * 4);
  return new Uint8Array(PNG.sync.write(png));
};

const engine = String.raw`
module RPG
  module Cache
    @cache = {}
    def self.picture(filename)
      path = "Graphics/Pictures/" + filename
      @cache[path] = Bitmap.new(path) if @cache[path].nil? || @cache[path].disposed?
      @cache[path]
    end
  end
end
`;

/** Loads the game's pictures and writes the colours of some of their pixels as JSON. */
const main = (report: string) => String.raw`
def color(b, x, y)
  c = b.get_pixel(x, y)
  [c.red.to_i, c.green.to_i, c.blue.to_i, c.alpha.to_i]
end
r = {}
begin
  sign = RPG::Cache.picture("sign")
  r["sign"] = [color(sign, 2, 2), color(sign, 20, 4), color(sign, 36, 20)]
  plain = Bitmap.new("Graphics/Pictures/Plain")
  r["plain"] = color(plain, 20, 4)
  r["blank"] = color(Bitmap.new(64, 32), 20, 4)
rescue Exception => e
  r["error"] = "#{e.class}: #{e.message[0, 300]} at #{(e.backtrace || [])[0, 3].join(" ")}"
end
File.open(${JSON.stringify(report)}, "w") do |f|
  f.write("{" + r.map { |k, v| k.inspect + ":" + (v.is_a?(String) ? v.inspect : v.inspect.gsub(" ", "")) }.join(",") + "}")
end
exit
`;

const Pixel = Schema.Tuple([Schema.Int, Schema.Int, Schema.Int, Schema.Int]);
const Report = Schema.Struct({
  error: Schema.optional(Schema.String),
  sign: Schema.Tuple([Pixel, Pixel, Pixel]),
  plain: Pixel,
  blank: Pixel,
});

it.live.skipIf(!xvfbRun)(
  "draws an image's tiles over it in mkxp-z when the game loads it, by any letter case",
  (context) =>
    Effect.gen(function* () {
      const program = yield* cachedMkxpz;
      if (Option.isNone(program)) return context.skip("mkxp-z isn't in RPGTL's cache folder");
      const blue = filled(64, 32, [0, 0, 255, 255]);
      // Two tiles: a red one, and a clear one that erases what was there.
      const tiles = new PNG({ width: 16, height: 32 });
      tiles.data.fill(0);
      for (let at = 0; at < 16 * 16; at++) tiles.data.set([255, 0, 0, 255], at * 4);
      const json = yield* playXpGame(program.value, {
        engine,
        main,
        archived: { "Graphics/Pictures/Sign.png": blue, "Graphics/Pictures/Plain.png": blue },
        patched: {
          "Graphics/RPGTL/tiles.png": new Uint8Array(PNG.sync.write(tiles)),
          [xpImageTableFile]: xpImageTable([
            {
              image: "Graphics/Pictures/Sign",
              tiles: "Graphics/RPGTL/tiles",
              places: [16, 0, 0, 16, 16, 32, 16, 16, 16, 16],
            },
          ]),
        },
      });
      const r = yield* Schema.decodeEffect(Schema.fromJsonString(Report))(json);
      assert.isUndefined(r.error);
      assert.deepStrictEqual(r.sign, [
        [0, 0, 255, 255],
        [255, 0, 0, 255],
        [0, 0, 0, 0],
      ]);
      assert.deepStrictEqual(r.plain, [0, 0, 255, 255]);
      assert.deepStrictEqual(r.blank, [0, 0, 0, 0]);
    }).pipe(Effect.scoped, Effect.provide(mkxpzLayer)),
  90_000,
);
