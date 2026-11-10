import { expect, test } from "vite-plus/test";
import { matchingSounds, onceEach } from "./sounds.ts";

const sources = (texts: string[]) => matchingSounds(texts).map((hint) => hint.source);

test("A phrase spelled for its sound matches with pauses between its syllables", () => {
  for (const text of [
    "呀...嘞...呀...嘞...真是拿你没办法",
    "呀嘞呀嘞",
    "压咧压咧~",
    "鸭嘞！{1}鸭嘞",
  ])
    expect(matchingSounds([text]).map((hint) => hint.translation)).toEqual(["Yare yare"]);
  expect(sources(["呀...嘞...呀...嘞...真是拿你没办法"])).toEqual(["呀...嘞...呀...嘞"]);
  expect(sources(["啊啦啊啦，真可爱", "阿拉……阿拉"])).toEqual(["啊啦啊啦"]);
  expect(sources(["咿呀！❤~"])).toEqual(["咿呀"]);
});

test("A phrase games shorten matches too, but only once with its full spelling", () => {
  expect(matchingSounds(["呀...嘞...你这么说也太过分了吧！"])).toEqual([
    expect.objectContaining({ source: "呀...嘞", translation: "Yare yare" }),
  ]);
  expect(sources(["呀...嘞...好", "呀...嘞...呀...嘞...好"])).toEqual(["呀...嘞...呀...嘞"]);
  expect(sources(["\\{啊...拉...别把我想得那么坏嘛"])).toEqual(["啊...拉"]);
  expect(sources(["啊......啦......啦......今天的运气真差啊"])).toEqual(["啊......啦......啦"]);
  expect(sources(["啊~啦~"])).toEqual(["啊~啦"]);
  // Without a pause, 啊啦 is plain Chinese.
  expect(sources(["啊啦，怎么又在发呆了？", "啊，啦啦队来了"])).toEqual([]);
});

test("A split phrase written twice for one spelling is written once", () => {
  expect(onceEach("呀...嘞...呀...嘞...好", "Yare yare... Yare yare... Fine.")).toBe(
    "Yare yare... Fine.",
  );
  expect(onceEach("呀...嘞...好", "Yare yare... yare yare... Fine.")).toBe("Yare yare... Fine.");
  expect(onceEach("（呀嘞呀嘞，啊啦啊啦）", "(Yare yare yare yare, ara ara)")).toBe(
    "(Yare yare, ara ara)",
  );
  expect(onceEach("啊...啦...啦...真不幸", "Ara ara... ara ara... How unfortunate.")).toBe(
    "Ara ara... How unfortunate.",
  );
  // A source that says it twice keeps both.
  expect(onceEach("呀嘞呀嘞...呀嘞呀嘞", "Yare yare... Yare yare")).toBe("Yare yare... Yare yare");
});

test("Short words and characters in other words don't match", () => {
  // A single 啊啦 is ordinary Chinese for "oh my", and 呀啊 is a plain scream.
  expect(sources(["啊啦，怎么又在发呆了？", "呀啊啊啊！", "呀，列车来了"])).toEqual([]);
  // Japanese words match only when written together.
  expect(sources(["哟！西瓜来了", "哟西，出发吧"])).toEqual(["哟西"]);
});

test("Each phrase is hinted once, with the spelling of the first text that has it", () => {
  expect(matchingSounds(["嘿嘿~这点小事难不倒我~", "嘿...嘿嘿，呜呜呜"])).toEqual([
    expect.objectContaining({ source: "呜呜", translation: "Waaah" }),
    expect.objectContaining({ source: "嘿嘿", translation: "Hehe" }),
  ]);
});
