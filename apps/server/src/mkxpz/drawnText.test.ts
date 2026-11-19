import { assert, it } from "@effect/vitest";
import { decodeXpFile, xpGameEntries } from "@rpgtl/domain";
import { xpFile, xpMap } from "@rpgtl/domain/testUtils/xpGame";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { cachedMkxpz, mkxpzLayer, playXpGame, xvfbRun } from "../testUtils/mkxpz.ts";

const map = xpFile(xpMap({ 4: [], 5: [] }, { 4: 'Exit[3,1,"北門",0]', 5: 'Exit[3,2,"南の塔",0]' }));
const entries = xpGameEntries([Result.getOrThrow(decodeXpFile("Map002.rxdata", map))]).map(
  (entry, index) => ({
    ...entry,
    textId: index + 1,
    isInImage: false,
    ...(entry.source === "北門" && { userTranslation: "North Gate" }),
  }),
);

/**
 * Draws a label read from a data file, as games read event names, and one from the script's own
 * text, then writes the text each draw reached the engine with and whether a label measures as its
 * English at the smallest size text fitting draws.
 */
const main = (report: string) => String.raw`
r = {}
begin
  $drawn = []
  class Bitmap
    alias_method :test_engine_draw_text, :rpgtl_draw_text
    def rpgtl_draw_text(*args)
      text = (args[0].is_a?(Rect) ? args[1] : args[4]).to_s
      $drawn << text.dup.force_encoding("UTF-8")
      test_engine_draw_text(*args)
    end
  end
  b = Bitmap.new(320, 96)
  b.draw_text(0, 0, 320, 32, load_data("Data/Labels.rxdata")[0])
  b.draw_text(Rect.new(0, 32, 320, 32), "北門")
  b.draw_text(0, 64, 320, 32, "南の塔")
  b.get_pixel(0, 0)
  r["drawn"] = $drawn
  measured = b.text_size("北門").width
  full = b.text_size("North Gate").width
  b.font.size = Bitmap.rpgtl_smallest(b.font.size)
  small = b.text_size("North Gate").width
  r["measured"] = (measured == small && small < full).to_s
rescue Exception => e
  r["error"] = "#{e.class}: #{e.message[0, 300]} at #{(e.backtrace || [])[0, 3].join(" ")}"
end
File.open(${JSON.stringify(report)}, "w") do |f|
  f.write("{" + r.map { |k, v| k.inspect + ":" + (v.is_a?(String) ? v.inspect : "[" + v.map { |s| s.inspect }.join(",") + "]") }.join(",") + "}")
end
exit
`;

const Report = Schema.Struct({
  error: Schema.optional(Schema.String),
  drawn: Schema.optional(Schema.Array(Schema.String)),
  measured: Schema.optional(Schema.String),
});

it.live.skipIf(!xvfbRun)(
  "draws the English of a label from an event name in mkxp-z, from data and from a script alike",
  (context) =>
    Effect.gen(function* () {
      const program = yield* cachedMkxpz;
      if (Option.isNone(program)) return context.skip("mkxp-z isn't in RPGTL's cache folder");
      const json = yield* playXpGame(program.value, {
        engine: "",
        main,
        entries,
        // Strings in RGSS data files are bytes without an encoding.
        patched: { "Data/Labels.rxdata": xpFile([new TextEncoder().encode("北門")]) },
      });
      const r = yield* Schema.decodeEffect(Schema.fromJsonString(Report))(json);
      assert.isUndefined(r.error);
      assert.deepStrictEqual(r.drawn, ["North Gate", "North Gate", "南の塔"]);
      assert.strictEqual(r.measured, "true");
    }).pipe(Effect.scoped, Effect.provide(mkxpzLayer)),
  90_000,
);
