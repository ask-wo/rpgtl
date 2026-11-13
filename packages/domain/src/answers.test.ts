import { assert, it } from "@effect/vitest";
import type { Entry } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import { checkAnswer, outOfOrder, requestText } from "./index.ts";

type Asked = Pick<Entry, "location" | "source">;

const messageEntry = (source: string): Asked => ({
  location: {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
    index: 0,
  },
  source,
});
const imageEntry = (source: string): Asked => ({
  location: { _tag: "ImageLines", image: "img/menus/main/commands/Recalled", lines: [0] },
  source,
});
const pluginEntry = (source: string): Asked => ({
  location: { _tag: "PluginSetting", plugin: "Other", keys: ["Line 1 Text"] },
  source,
});
const accepted = (translation: string, flag?: string) =>
  Result.succeed(flag === undefined ? { translation } : { translation, flag });

it("An answer longer than its image's room is flagged, together with other flags", () => {
  assert.deepStrictEqual(
    checkAnswer(imageEntry("鉴赏"), "Gallery", { limit: 7 }),
    accepted("Gallery"),
  );
  assert.deepStrictEqual(
    checkAnswer(imageEntry("鉴赏"), "Gallery", { limit: 6 }),
    accepted("Gallery", "longer than the image has room for"),
  );
  assert.deepStrictEqual(
    checkAnswer(pluginEntry("第一行\n第二行"), "One line", { limit: 5 }),
    accepted("One line", "line breaks differ from the source; longer than the image has room for"),
  );
});

it("An answer ending with a number on its own line loses it unless the source has one", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("我很兴奋。"), "I'm excited.\n\n3"),
    accepted("I'm excited."),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("第一章\n1"), "Chapter One\n1"),
    accepted("Chapter One\n1", "line breaks differ from the source"),
  );
});

it("An answer that writes a split phrase twice for one spelling writes it once", () => {
  assert.deepStrictEqual(
    checkAnswer(
      messageEntry("呀...嘞...呀...嘞...你又迟到了？"),
      "Yare yare... Yare yare... Late again?",
    ),
    accepted("Yare yare... Late again?"),
  );
});

it("An answer that starts with the speaker's name or part of it loses it", () => {
  const speaker = { source: "罗伊·斯通", translation: "Roy Stone" };
  assert.deepStrictEqual(
    checkAnswer(messageEntry("呀...嘞...好。"), "Roy: Fine.", { speaker }),
    accepted("Fine."),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("好。"), "Stone: Fine.", { speaker }),
    accepted("Fine."),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("好。"), "Bartholomew: Fine.", { speaker }),
    accepted("Bartholomew: Fine."),
  );
});

it("An answer in quotes loses them unless the source is quoted", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("妈妈早。"), `"Morning, brother."`),
    accepted("Morning, brother."),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("「妈妈早。」"), "“Morning, brother.”"),
    accepted("“Morning, brother.”"),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("他说“早”。"), `He said "morning".`),
    accepted(`He said "morning".`),
  );
});

it("An answer holding other entries' answers is rejected", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("早上好。"), `"Good morning."\n\n"2": "You're up early."`),
    Result.fail("other entries included"),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("早上好。"), "Good morning.\n\n2\n\nYou're up early.\n\n3\n\nYes."),
    Result.fail("other entries included"),
  );
  assert.isTrue(
    Result.isSuccess(checkAnswer(messageEntry("第一章\n1\n开始"), "Chapter One\n1\nStart")),
  );
});

it("An answer with braces the source doesn't have is rejected", () => {
  assert.deepStrictEqual(
    checkAnswer(
      messageEntry("绕开了山路上的盗贼们。"),
      "Avoided the {thief}s on the mountain road.",
    ),
    Result.fail("placeholder extra"),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("{盗贼}来了。"), "{Thieves} are coming."),
    accepted("{Thieves} are coming."),
  );
});

it("A batch whose last answer is empty or repeats a sentence before it is out of order", () => {
  const batch = [{ text: "第一句" }, { text: "第二句" }, { text: "第三句" }];
  assert.isTrue(outOfOrder(batch, ["One and two.", "Three.", ""]));
  const three = "This is line three.";
  assert.isTrue(outOfOrder(batch, ["One and two.", three, three]));
  assert.isFalse(outOfOrder(batch, ["One.", "Huh?", "Huh?"]));
  assert.isFalse(outOfOrder(batch, ["One.", "Two.", "Three."]));
  assert.isFalse(outOfOrder([{ text: "嗯？" }, { text: "嗯？" }], ["Hm?", "Hm?"]));
  assert.isFalse(outOfOrder([{ text: "第一句" }], [""]));
});

it("Korean or kana sent back unchanged or left in the answer is rejected, but not ・ in a name", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("오늘은 비가 와요."), "오늘은 비가 와요."),
    Result.fail("unchanged"),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("오늘은 비가 와요."), "Today 비가 falls."),
    Result.fail("source text left"),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("ねえ、まだかな？"), "Hey, まだ yet?"),
    Result.fail("source text left"),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("ミナ・ハルです。"), "I'm Mina・Haru."),
    accepted("I'm Mina・Haru."),
  );
});

it("A first line that is only the speaker's name stays apart from the text", () => {
  const entry = messageEntry("ミナ\nと、とにかく逃げて！");
  assert.strictEqual(requestText(entry).text, "ミナと、とにかく逃げて！");
  const speaker = { source: "ミナ", translation: "Mina" };
  assert.deepStrictEqual(
    checkAnswer(entry, "Mina: J-just run!", { speaker }),
    accepted("ミナ\nJ-just run!"),
  );
  assert.deepStrictEqual(checkAnswer(messageEntry("ミナ"), "Mina", { speaker }), accepted("Mina"));
});

it("A circle mark or a quoted character the line is about may stay in the answer", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("〇/✕\nテストに受かった！"), "〇/✕ I passed the test!"),
    accepted("〇/✕ I passed the test!"),
  );
  const kana = messageEntry("「ァ」と「ア」をよく間違える");
  assert.deepStrictEqual(
    checkAnswer(kana, 'People often mix up the small "ァ" and "ア".'),
    accepted('People often mix up the small "ァ" and "ア".'),
  );
  assert.deepStrictEqual(
    checkAnswer(kana, 'People often "間違える" the small ァ and ア.'),
    Result.fail("source text left"),
  );
});

it("Pauses inside a line reach the model as markers, which its answer's markers become again", () => {
  const entry = messageEntry("等一下……\\!我马上来，\\.你先走。");
  assert.strictEqual(requestText(entry).text, "等一下……⏸我马上来，⏸你先走。");
  assert.deepStrictEqual(
    checkAnswer(entry, "Wait a moment...⏸I'll be right there, ⏸you go ahead."),
    accepted("Wait a moment...\\! I'll be right there, \\.you go ahead."),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("내 이름은 민호, \\!요리사야"), "My name is Minho ⏸ the cook"),
    accepted("My name is Minho,\\! the cook"),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("언젠가 또 보자 \\!조심해"), "See you someday ⏸ Take care"),
    accepted("See you someday.\\! Take care"),
  );
});

it("A pause the answer leaves out stays out, and the markers it keeps take the nearest pauses", () => {
  assert.deepStrictEqual(
    checkAnswer(
      messageEntry("等一下……\\!我马上来，\\.你先走。"),
      "Wait, I'll be right there... ⏸go ahead.",
    ),
    accepted("Wait, I'll be right there... \\.go ahead."),
  );
});

it("Without markers, the pauses are placed by the source's punctuation", () => {
  assert.deepStrictEqual(
    checkAnswer(
      messageEntry("等一下……\\!我马上来，\\.你先走。"),
      "Wait a moment... I'll be right there, you go ahead.",
    ),
    accepted("Wait a moment...\\! I'll be right there,\\. you go ahead."),
  );
});

it("With more markers than pauses, each pause takes the nearest marker and the others go", () => {
  assert.deepStrictEqual(
    checkAnswer(
      messageEntry("그 선배, 대장보다 더 센 것 같아! \\!하하하!"),
      "That senior seems ⏸stronger than the captain! ⏸Hahaha!",
    ),
    accepted("That senior seems stronger than the captain! \\!Hahaha!"),
  );
});

it("A marker at the answer's end that copies the source's edge pause is dropped", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("来了。\\!走吧。\\!"), "Coming.⏸Let's go.⏸"),
    accepted("Coming.\\! Let's go.\\!"),
  );
});

it("A pause after punctuation the English lacks goes to the nearest punctuation or word", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("嗯，好吧……\\!那我们走吧。"), "Fine... then let's go."),
    accepted("Fine...\\! then let's go."),
  );
  assert.deepStrictEqual(
    checkAnswer(messageEntry("真的吗？\\!太好了！"), "Really great!"),
    accepted("Really \\!great!"),
  );
});

it("A pause between words goes to the start of the word at the same place in the English", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("그런데 왜 \\!내가 가야 하는데?"), "But why do I have to go?"),
    accepted("But why \\!do I have to go?"),
  );
});

it("A pause beside a kept line break stays at that line break", () => {
  assert.deepStrictEqual(
    checkAnswer(pluginEntry("第一行\\!\n\\.第二行"), "Line one\nLine two"),
    accepted("Line one\\!\n\\.Line two"),
  );
});

it("Pauses at a line's edges stay where they are", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("\\.来了\\!"), "Coming"),
    accepted("\\.Coming\\!"),
  );
});

it("A comma between Korean words is punctuation a pause follows, a point in a number is not", () => {
  assert.deepStrictEqual(
    checkAnswer(messageEntry("빵,\\!우유,\\!사과 0.5\\!개"), "Bread, milk, apple 0.5 piece"),
    accepted("Bread,\\! milk,\\! apple 0.5 \\!piece"),
  );
});

it("A line break joins Chinese lines without a space and Korean lines with one", () => {
  assert.strictEqual(requestText(messageEntry("我们明天\n一起去吧。")).text, "我们明天一起去吧。");
  assert.strictEqual(requestText(messageEntry("내일은\n같이 가자.")).text, "내일은 같이 가자.");
});

it("A row of icons keeps its line breaks", () => {
  assert.strictEqual(
    requestText(messageEntry("\\I[3](A)　\\I[4](B)\n\\I[5](C)\nこのボタンを\n使うよ。")).text,
    "(A)　{1}(B)\n{2}(C)\nこのボタンを使うよ。",
  );
});

it("A pause at a joined line break goes after the nearest punctuation in the English", () => {
  assert.deepStrictEqual(
    checkAnswer(
      messageEntry("축제가 시작됐어\n\\!빵집 주인은 아직 몰라"),
      "The festival has started. The baker doesn't know yet.",
    ),
    accepted("The festival has started.\\! The baker doesn't know yet."),
  );
});

it("A pause placed between words skips the words of a colored name", () => {
  assert.deepStrictEqual(
    checkAnswer(
      messageEntry("이곳은 \\C[6]푸른 언덕 마을\\C[0]의\n\\!촌장입니다"),
      "I'm the chief of {1}Blue Hill Village{2}",
    ),
    accepted("I'm the chief of \\!\\C[6]Blue Hill Village\\C[0]"),
  );
});

it("A color at a line's edge is sent as a placeholder when the line colors only some of its words", () => {
  const entry = messageEntry("\\C[6]푸른 언덕 마을\\C[0]에 어서 와");
  assert.strictEqual(requestText(entry).text, "{1}푸른 언덕 마을{2}에 어서 와");
  assert.deepStrictEqual(
    checkAnswer(entry, "Welcome to {1}Blue Hill Village{2}"),
    accepted("Welcome to \\C[6]Blue Hill Village\\C[0]"),
  );
  assert.strictEqual(
    requestText(messageEntry("\\C[6]푸른 언덕 마을\\C[0]")).text,
    "푸른 언덕 마을",
  );
});

it("Pauses keep their order and their own punctuation when the English adds a comma", () => {
  assert.deepStrictEqual(
    checkAnswer(
      messageEntry("\\n<점원>사과,\\!배,\\!포도\\!,수박\n\\!그리고 딸기가 있어요!"),
      "There are apples, pears, grapes, watermelons, and strawberries!",
    ),
    accepted(
      "\\n<점원>There are apples,\\! pears,\\! grapes\\!, watermelons,\\! and strawberries!",
    ),
  );
});

it("an XP name's tags go back where they were, and an answer without the inner one is rejected", () => {
  const state: Asked = {
    location: { _tag: "RecordField", table: "states", record: 4, field: "name" },
    source: "[仮]霧よけ（[RATE]%）",
  };
  const request = requestText(state, undefined, true);
  assert.strictEqual(request.text, "霧よけ（{1}%）");
  assert.deepStrictEqual(
    checkAnswer(state, "Mist Guard ({1}%)", {}, true),
    accepted("[仮]Mist Guard ([RATE]%)"),
  );
  assert.isTrue(Result.isFailure(checkAnswer(state, "Mist Guard (%)", {}, true)));
});

it("an XP description keeps its tags and its | where the game breaks the line", () => {
  const armor: Asked = {
    location: { _tag: "RecordField", table: "armors", record: 3, field: "description" },
    source: "[G4]雨の日の兜。|風邪を防ぐ。",
  };
  assert.strictEqual(requestText(armor, undefined, true).text, "雨の日の兜。{1}風邪を防ぐ。");
  assert.deepStrictEqual(
    checkAnswer(armor, "A helmet for rainy days.{1}Guards against colds.", {}, true),
    accepted("[G4]A helmet for rainy days.|Guards against colds."),
  );
  assert.isTrue(
    Result.isFailure(
      checkAnswer(armor, "A helmet for rainy days.\nGuards against colds.", {}, true),
    ),
  );
});

it("A Ruby `#{}` in a script's string is sent as a placeholder and comes back as it was", () => {
  const entry = messageEntry("所持金：#{$game_party.gold}枚");
  assert.strictEqual(requestText(entry).text, "所持金：{1}枚");
  assert.deepStrictEqual(
    checkAnswer(entry, "Gold: {1} coins"),
    accepted("Gold: #{$game_party.gold} coins"),
  );
});

it("A `{2}` in the source is sent as a placeholder, so the answer may keep it", () => {
  const entry = messageEntry("三重灾难{2}");
  assert.strictEqual(requestText(entry).text, "三重灾难{1}");
  assert.deepStrictEqual(checkAnswer(entry, "Triple Disaster{1}"), accepted("Triple Disaster{2}"));
});

it("A code that a line break splits is sent as one placeholder and comes back as it was", () => {
  const entry = messageEntry("回到\\C[2]旧城\\C\n[0]吧");
  assert.strictEqual(requestText(entry).text, "回到{1}旧城{2}吧");
  assert.deepStrictEqual(
    checkAnswer(entry, "Back to {1}the old castle{2}"),
    accepted("Back to \\C[2]the old castle\\C\n[0]"),
  );
});
