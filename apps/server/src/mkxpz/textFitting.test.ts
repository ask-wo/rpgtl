import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { cachedMkxpz, mkxpzLayer, playXpGame, xvfbRun } from "../testUtils/mkxpz.ts";

/** Stand-ins for the parts of RGSS's default scripts that the fitting script hooks. */
const engine = String.raw`
class Game_Temp
  attr_accessor :message_text, :choice_start, :choice_max, :num_input_start, :num_input_variable_id
  def initialize; @choice_start = 99; @choice_max = 0; @num_input_start = 99; @num_input_variable_id = 0; end
end
class Bitmap
  def draw_frame_text(x, y, width, height, string, align = 0)
    origin_color = font.color.dup
    font.color = Color.new(0, 0, 0)
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].each { |dx, dy| draw_text(x + dx, y + dy, width, height, string, align) }
    font.color = origin_color
    draw_text(x, y, width, height, string, align)
  end
end
class Window_Message < Window
  attr_reader :shown
  def initialize(widens)
    super()
    @widens = widens
    self.x = 80; self.y = 304; self.width = 480; self.height = 160
    self.contents = Bitmap.new(width - 32, height - 32)
  end
  def refresh
    if @widens
      self.width = 640
      self.contents = Bitmap.new(608, 128)
    end
    @shown = $game_temp.message_text.dup
    $draws += 1
  end
  def terminate_message
    $game_temp.message_text = nil
  end
end
`;

/** Draws labels and messages the way games do and writes what the engine drew as JSON. */
const checks = (report: string) => String.raw`
def json(value)
  case value
  when Array then "[" + value.map { |v| json(v) }.join(",") + "]"
  when Hash then "{" + value.map { |k, v| k.to_s.inspect + ":" + json(v) }.join(",") + "}"
  when nil then "null"
  else value.inspect
  end
end
RED = lambda { |c| c.alpha > 200 && c.red > 200 && c.green < 80 }
INKED = lambda { |c| c.alpha > 0 }
def rightmost(b, test, xs = 0...b.width, ys = 0...b.height)
  xs.select { |x| ys.any? { |y| test.call(b.get_pixel(x, y)) } }.max || -1
end
def red_bitmap(w, h = 32)
  b = Bitmap.new(w, h)
  b.font.color = Color.new(255, 0, 0)
  b
end
def message(window, text, choices = 0)
  $game_temp.message_text = text
  $game_temp.choice_max = choices
  $game_temp.choice_start = choices > 0 ? text.count("\n") - choices : 99
  $draws = 0
  window.refresh
  { "rows" => window.shown.split("\n"), "widths" => window.shown.split("\n").map { |l| window.contents.text_size(l).width }, "draws" => $draws }
end
r = {}
begin
  $game_temp = Game_Temp.new
  b = Bitmap.new(200, 32)
  r["fontSize"] = b.font.size
  r["label"] = { "natural" => b.text_size("Equipment and accessories").width }
  b.draw_text(0, 0, 80, 32, "Equipment and accessories")
  r["label"]["right"] = rightmost(b, INKED)
  r["label"]["fontAfter"] = b.font.size
  b = Bitmap.new(100, 32)
  b.draw_text(Rect.new(60, 0, 120, 32), "Status", 0)
  r["edge"] = rightmost(b, INKED)
  b = red_bitmap(300)
  b.draw_text(0, 0, 128, 32, "Element")
  b.font.color = Color.new(0, 255, 0)
  b.draw_text(48, 0, 200, 32, "Phys Def")
  r["beforeNext"] = { "natural" => b.text_size("Element").width, "right" => rightmost(b, RED) }
  b = Bitmap.new(120, 32)
  ["Heavy", "Magic", "Light"].each_with_index do |t, i|
    b.font.color = i == 0 ? Color.new(255, 0, 0) : Color.new(0, 0, 255)
    b.draw_frame_text(i * 24, 0, 32, 32, t)
  end
  r["outlined"] = rightmost(b, RED)
  b = red_bitmap(300)
  b.draw_text(0, 0, 200, 32, "State Details")
  b.blt(80, 4, Bitmap.new(24, 24), Rect.new(0, 0, 24, 24))
  r["beforeIcon"] = rightmost(b, RED)
  b = red_bitmap(640)
  b.draw_text(248, 0, 80, 32, "7th Kyu rank")
  b.fill_rect(0, 26, 304, 4, Color.new(16, 16, 16))
  b.font.color = Color.new(0, 255, 0)
  b.draw_text(316, 0, 128, 32, "Spear")
  r["overGauge"] = { "natural" => b.text_size("7th Kyu rank").width, "right" => rightmost(b, RED) }
  bar = Bitmap.new(640, 32)
  [["State Details", 8], ["Proficiency Ranks", 160], ["Passive", 288], ["Weapon Details", 416]].each do |t, at|
    buf = red_bitmap(608)
    buf.fill_rect(0, 4, 24, 24, Color.new(255, 255, 255))
    buf.draw_text(24, 0, 584, 32, t)
    bar.blt(at, 0, buf, buf.rect)
    buf.dispose
  end
  r["copied"] = [160, 288, 416].map { |edge| rightmost(bar, RED, 0...edge) }
  b = red_bitmap(300)
  b.draw_text(0, 0, 300, 32, "Room to spare")
  r["alone"] = { "natural" => b.text_size("Room to spare").width, "right" => rightmost(b, RED) }

  w = Window_Message.new(false)
  r["choicesBelow"] = message(w, "Short line\nThis line of English is much longer than \nthe window of the game can show at once, so it breaks \nWWWWWWWWWW WWWWWWWWWW WWWWWWWWWW\nYes\nNo\n", 2)
  long = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty, " * 2 + "end.\n"
  r["long"] = { "text" => long, "pages" => [message(w, long)] }
  w.terminate_message
  $draws = 0
  w.refresh
  r["long"]["pages"] << { "rows" => w.shown.split("\n"), "draws" => $draws }
  w.terminate_message
  r["long"]["after"] = $game_temp.message_text

  $rpgtl_message_room = nil
  wide = "A line that is wider than the default window but fits a wide one.\n"
  r["widens"] = message(Window_Message.new(true), wide)
  $rpgtl_message_room = nil
  r["fixed"] = message(Window_Message.new(false), wide)
  r["fixed"]["room"] = $rpgtl_message_room
  r["fixedAgain"] = message(Window_Message.new(false), wide)
rescue Exception => e
  r["error"] = "#{e.class}: #{e.message[0, 300]} at #{(e.backtrace || [])[0, 3].join(" ")}"
end
File.open(${JSON.stringify(report)}, "w") { |f| f.write(json(r)) }
exit
`;

const Message = Schema.Struct({
  rows: Schema.Array(Schema.String),
  widths: Schema.Array(Schema.Int),
  draws: Schema.Int,
});
const Fitted = Schema.Struct({ natural: Schema.Int, right: Schema.Int });
const Report = Schema.Struct({
  error: Schema.optional(Schema.String),
  fontSize: Schema.Int,
  label: Schema.Struct({ natural: Schema.Int, right: Schema.Int, fontAfter: Schema.Int }),
  edge: Schema.Int,
  beforeNext: Fitted,
  outlined: Schema.Int,
  beforeIcon: Schema.Int,
  overGauge: Fitted,
  copied: Schema.Tuple([Schema.Int, Schema.Int, Schema.Int]),
  alone: Fitted,
  choicesBelow: Message,
  long: Schema.Struct({
    text: Schema.String,
    pages: Schema.Tuple([
      Message,
      Schema.Struct({ rows: Schema.Array(Schema.String), draws: Schema.Int }),
    ]),
    after: Schema.NullOr(Schema.String),
  }),
  widens: Message,
  fixed: Schema.Struct({ ...Message.fields, room: Schema.Int }),
  fixedAgain: Message,
});

it.live.skipIf(!xvfbRun)(
  "fits labels and messages in mkxp-z, with the fitting script loaded twice",
  (context) =>
    Effect.gen(function* () {
      const program = yield* cachedMkxpz;
      if (Option.isNone(program)) return context.skip("mkxp-z isn't in RPGTL's cache folder");
      const r = yield* Schema.decodeEffect(Schema.fromJsonString(Report))(
        yield* playXpGame(program.value, { engine, main: checks }),
      );
      assert.isUndefined(r.error);

      assert.isAbove(r.label.natural, 80);
      assert.isAtMost(r.label.right, 80);
      assert.strictEqual(r.label.fontAfter, r.fontSize);
      assert.isBelow(r.edge, 100);
      assert.isAbove(r.beforeNext.natural, 48);
      assert.isBelow(r.beforeNext.right, 48);
      assert.isBelow(r.outlined, 24);
      assert.isBelow(r.beforeIcon, 80);
      assert.isAbove(r.overGauge.natural, 316 - 248);
      assert.isBelow(r.overGauge.right, 316);
      assert.isTrue(r.copied[0] < 160 && r.copied[1] < 288 && r.copied[2] < 416);
      assert.isAtLeast(r.alone.right, r.alone.natural - 3);

      assert.deepStrictEqual(r.choicesBelow.rows, [
        "Short line",
        "This line of English is much longer than ",
        "the window of the game can show at once, so it breaks ",
        "WWWWWWWWWW WWWWWWWWWW WWWWWWWWWW",
        "Yes",
        "No",
      ]);

      const [first, second] = r.long.pages;
      assert.lengthOf(first.rows, 4);
      assert.isTrue(first.widths.every((width) => width <= 444));
      assert.deepStrictEqual(
        [...first.rows, ...second.rows].join(" ").split(" "),
        r.long.text.trim().split(" "),
      );
      assert.deepStrictEqual([first.draws, second.draws, r.long.after], [1, 1, null]);

      assert.deepStrictEqual(r.widens.rows, [
        "A line that is wider than the default window but fits a wide one.",
      ]);
      assert.strictEqual(r.widens.draws, 1);
      assert.strictEqual(r.fixed.room, 444);
      assert.strictEqual(r.fixed.draws, 2);
      assert.lengthOf(r.fixed.rows, 2);
      assert.isTrue(r.fixed.widths.every((width) => width <= 444));
      assert.deepInclude(r.fixedAgain, { rows: r.fixed.rows, draws: 1 });
    }).pipe(Effect.scoped, Effect.provide(mkxpzLayer)),
  90_000,
);
