import { assert, it } from "@effect/vitest";
import { rubyLiterals } from "./rubyLiterals.ts";

const literalsOf = (code: string) =>
  rubyLiterals(code).map(({ start, end }) => code.slice(start, end));

it("finds the string literals of Ruby code, past what only looks like one", () => {
  const code = [
    `# a comment with "quotes"`,
    `=begin`,
    `"inside a block comment"`,
    `=end`,
    `text = $game_switches[26] ? "Gold" :"金币"`,
    `name = "#{actor.name("x")}的剑" + 'it\\'s'`,
    `parts = line.split(/"/) + %w(a "b") + [?", :"sym", $"]`,
    `rate = total / count / 2; label = "比例"`,
    `self.contents.draw_text(0, 0, 100, 32, "体力 \\"满\\"")`,
  ].join("\n");
  assert.deepStrictEqual(literalsOf(code), [
    `"Gold"`,
    `"金币"`,
    `"#{actor.name("x")}的剑"`,
    `'it\\'s'`,
    `"比例"`,
    `"体力 \\"满\\""`,
  ]);
});

it("finds no literals in a script with a heredoc, which it doesn't follow", () => {
  assert.deepStrictEqual(literalsOf(`text = <<-EOS\n"不是"\nEOS\nname = "名字"`), []);
});
