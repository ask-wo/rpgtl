import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { archiveEntries, decodeXpFile, decryptEntry, xpGameEntries } from "../../index.ts";
import { command, rubyObject, xpArchive, xpMap } from "../../testUtils/xpGame.ts";

const inMemory = (bytes: Uint8Array) => (offset: number, length: number) =>
  Effect.succeed(bytes.subarray(offset, offset + length));

const entriesOf = Effect.fn("entriesOf")(function* (files: Record<string, unknown>) {
  const archive = xpArchive(files);
  const stored = yield* archiveEntries("Game.rgssad", archive.length, inMemory(archive));
  return xpGameEntries(
    yield* Effect.forEach(stored, (entry) =>
      Effect.fromResult(
        decodeXpFile(
          entry.path.slice("Data/".length),
          decryptEntry(entry, archive.subarray(entry.offset, entry.offset + entry.size)),
        ),
      ),
    ),
  );
});

it.effect("reads messages, choices, names and script texts from an XP game's archive", () =>
  Effect.gen(function* () {
    const entries = yield* entriesOf({
      "Map002.rxdata": xpMap({
        3: [
          command(101, "你好，"),
          command(401, "旅行者。"),
          command(102, ["是", "OK", ""], 2),
          command(402, 0, "是"),
          command(320, 1, "小明"),
          command(355, '$msg_name = "店主"'),
          command(655, "s1 = 'a\\'b' if $game_variables[2] == \"龙\\n\""),
          command(355, 'x = "#{name}的剑"; y = "\\e剑"'),
          command(101, " "),
        ],
      }),
      "Items.rxdata": [
        null,
        rubyObject("RPG::Item", {
          id: 1,
          name: "药水",
          description: "恢复体力。",
          icon_name: "potion",
        }),
      ],
      "System.rxdata": rubyObject("RPG::System", {
        words: rubyObject("RPG::System::Words", { gold: "金", hp: "" }),
        elements: ["", "火"],
      }),
    });
    const list = { _tag: "MapEventPage", map: 2, event: 3, page: 0 } as const;
    const commandText = (index: number, parameter: number, keys: ReadonlyArray<string>) =>
      ({ _tag: "CommandText", list, index, parameter, keys }) as const;
    const scriptText = (index: number, literal: number) =>
      ({ _tag: "ScriptText", list, index, parameter: 0, literal }) as const;
    assert.deepStrictEqual(
      entries.map(({ location, source }) => [location, source]),
      [
        [{ _tag: "Message", list, index: 0 }, "你好，\n旅行者。"],
        [commandText(2, 0, ["0"]), "是"],
        [commandText(2, 0, ["1"]), "OK"],
        [commandText(3, 1, []), "是"],
        [commandText(4, 1, []), "小明"],
        [scriptText(5, 0), "店主"],
        [scriptText(6, 1), "龙\n"],
        [{ _tag: "RecordField", table: "items", record: 1, field: "name" }, "药水"],
        [{ _tag: "RecordField", table: "items", record: 1, field: "description" }, "恢复体力。"],
        [{ _tag: "SystemText", keys: ["words", "gold"] }, "金"],
        [{ _tag: "SystemText", keys: ["elements", "1"] }, "火"],
      ],
    );
    // sha256 of the JSON of ["XP", location, source], computed outside the code: an entry whose id
    // changes loses its saved translation.
    assert.strictEqual(entries[0]?.id, "8fa98c9231fb56c6e596eec1");
  }),
);

it.effect("refuses an archive that ends in the middle of a file", () =>
  Effect.gen(function* () {
    const archive = xpArchive({ "Items.rxdata": [] }).slice(0, -2);
    const error = yield* Effect.flip(
      archiveEntries("Game.rgssad", archive.length, inMemory(archive)),
    );
    assert.strictEqual(error._tag, "GameFileInvalid");
  }),
);
