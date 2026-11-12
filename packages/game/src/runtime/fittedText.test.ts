import { test, expect } from "vite-plus/test";
import { appliedSystem, loadRuntime } from "../testUtils/fixture.ts";

test("runtime draws a dotted actor name by its short form only on HUD bitmaps it overflows", async () => {
  const system = appliedSystem([
    {
      id: "a",
      location: { _tag: "RecordField", table: "actors", record: 1, field: "name" },
      source: "藤原·雄一郎",
      translation: { user: "Fujiwara Yuichiro" },
    },
    {
      id: "b",
      location: { _tag: "RecordField", table: "actors", record: 2, field: "name" },
      source: "星澜",
      translation: { user: "Xinglan" },
    },
  ]);
  expect(system.rpgtlShortNames).toEqual({
    "Fujiwara Yuichiro": { source: "藤原·雄一郎", short: "Yuichiro" },
  });
  const drawn: string[] = [];
  class Bitmap {
    // Chinese characters are about twice as wide as English letters.
    measureTextWidth(text: string) {
      return Array.from(text).reduce(
        (width, char) => width + (/\p{Script=Han}/u.test(char) ? 20 : 10),
        0,
      );
    }
    drawText(text: string) {
      drawn.push(text);
    }
  }
  class Window_Base {
    contents = new Bitmap();
    drawText(text: string) {
      this.contents.drawText(text);
    }
  }
  await loadRuntime("MV", { Bitmap, Window_Base, $dataSystem: system });
  new Bitmap().drawText("Fujiwara Yuichiro");
  new Window_Base().drawText("Fujiwara Yuichiro");
  new Bitmap().drawText("Xinglan");
  expect(drawn).toEqual(["Yuichiro", "Fujiwara Yuichiro", "Xinglan"]);
});

test("runtime draws a class name wider than the original in a font that fits the original", async () => {
  const system = appliedSystem([
    {
      id: "a",
      location: { _tag: "RecordField", table: "classes", record: 1, field: "name" },
      source: "暗影咒术师",
      translation: { user: "Shade Warlock" },
    },
    {
      id: "b",
      location: { _tag: "RecordField", table: "classes", record: 2, field: "name" },
      source: "魔剑士",
      translation: { user: "Fencer" },
    },
    {
      id: "c",
      location: { _tag: "RecordField", table: "classes", record: 3, field: "name" },
      source: "见习魔导士",
      translation: { user: "Trainee Sorcerer" },
    },
  ]);
  expect(system.rpgtlClassNames).toEqual({
    "Shade Warlock": "暗影咒术师",
    Fencer: "魔剑士",
    "Trainee Sorcerer": "见习魔导士",
  });
  const drawn: { text: string; width?: number | undefined; fontSize: number }[] = [];
  class Window_Base {
    contents = { width: 400, height: 400, fontSize: 22 };
    // Chinese characters are about twice as wide as English letters.
    textWidth(text: string) {
      const size = this.contents.fontSize;
      return Array.from(text).reduce(
        (width, char) => width + (/\p{Script=Han}/u.test(char) ? size : size / 2),
        0,
      );
    }
    drawText(text: string, _x: number, _y: number, width?: number) {
      drawn.push({ text, width, fontSize: this.contents.fontSize });
    }
    drawActorClass(
      actor: { currentClass(): { name: string } },
      x: number,
      y: number,
      width?: number,
    ) {
      this.drawText(actor.currentClass().name, x, y, width || 168);
    }
  }
  await loadRuntime("MV", { Window_Base, $dataSystem: system });
  const window = new Window_Base();
  for (const name of [
    "Shade Warlock",
    "Fencer",
    "Trainee Sorcerer",
    "Shade Warlock Supreme Of All",
  ])
    window.drawActorClass({ currentClass: () => ({ name }) }, 65, 0);
  // 暗影咒术师 is 110px at 22px; Shade Warlock is 143px, so it gets 116 / 143 of the size.
  // Trainee Sorcerer would need 14px and stops at 70% of the size; the width squeezes the rest.
  expect(drawn).toEqual([
    { text: "Shade Warlock", width: 116, fontSize: 17 },
    { text: "Fencer", width: 168, fontSize: 22 },
    { text: "Trainee Sorcerer", width: 116, fontSize: 16 },
    { text: "Shade Warlock Supreme Of All", width: 168, fontSize: 22 },
  ]);
  expect(window.contents.fontSize).toBe(22);
});

test("runtime draws item names that don't fit smaller and ends them where the price begins", async () => {
  const drawn: { text: string; width?: number | undefined; fontSize: number }[] = [];
  class Window_Base {
    contents = { width: 400, height: 400, fontSize: 22 };
    width = 370;
    _data: ({ name: string } | null)[] = [];
    textWidth(text: string) {
      return (text.length * this.contents.fontSize) / 2;
    }
    textPadding() {
      return 6;
    }
    lineHeight() {
      return 36;
    }
    drawText(text: string, _x: number, _y: number, width?: number) {
      drawn.push({ text, width, fontSize: this.contents.fontSize });
    }
    // As YEP_CoreEngine draws them.
    drawItemName(item: { name: string } | null, x: number, y: number, width: number) {
      if (item) this.drawText(item.name, x + 36, y, width - 36);
    }
  }
  class Window_ItemList extends Window_Base {
    maxCols() {
      return 2;
    }
    itemWidth() {
      return Math.floor((this.width - 36 + 48) / this.maxCols() - 48);
    }
    numberWidth() {
      return 33;
    }
  }
  // YEP_CoreEngine passes the whole row for the name and draws the price over its right end.
  class Window_ShopBuy extends Window_ItemList {
    itemRect() {
      return { x: 0, width: 334 };
    }
    price() {
      return 120;
    }
    drawItem(index: number) {
      this.drawItemName(this._data[index]!, 0, 0, 328);
      this.drawText(String(this.price()), 0, 0, 328);
    }
  }
  await loadRuntime("MV", { Window_Base, Window_ItemList, Window_ShopBuy });
  const buy = new Window_ShopBuy();
  buy._data = [{ name: "Silver Moonlight Pendant" }, { name: "Iron Lockpicks" }];
  buy.drawItem(0);
  buy.drawItem(1);
  // The price is 33px at 22px, so the name has 334 - 12 - 33 - 36 = 253px of the 292px it's given.
  // Silver Moonlight Pendant is 264px and gets 253 / 264 of the size.
  expect(drawn).toEqual([
    { text: "Silver Moonlight Pendant", width: 253, fontSize: 21 },
    { text: "120", width: 328, fontSize: 22 },
    { text: "Iron Lockpicks", width: 253, fontSize: 22 },
    { text: "120", width: 328, fontSize: 22 },
  ]);
  expect(buy.contents.fontSize).toBe(22);

  // Two columns leave a name 74px: room for 105px names at 70% of the size, but not more.
  const sell = new Window_ItemList();
  sell._data = [{ name: "Apple" }, null, { name: "Egg Tart" }];
  expect(sell.maxCols()).toBe(2);
  sell._data = [{ name: "Apple" }, null, { name: "Large Healing Potion Kit" }];
  expect(sell.maxCols()).toBe(1);
  sell.width = 816;
  expect(sell.maxCols()).toBe(2);
});

test("runtime keeps text hidden that a window draws mostly left of itself", async () => {
  class Window_Base {
    contents = { width: 400, height: 72, fontSize: 28 };
    drawn: string[] = [];
    textWidth(text: string) {
      return text.length * 10;
    }
    resetFontSettings() {}
    convertEscapeCharacters(text: string) {
      return text;
    }
    drawText(text: string, _x: number, _y: number, _width?: number, _align?: string) {
      this.drawn.push(text);
    }
  }
  await loadRuntime("MV", { Window_Base });
  const win = new Window_Base();
  // Squeezed into 276px from -164, the name would show its last 112px.
  win.drawText("\\C[26]Golden Dragon Scale-Reinforced Armor", -164, 0, 276);
  win.drawText("Coat", -10, 0, 276);
  win.drawText("Right", -100, 0, 160, "right");
  win.drawText("Gone", -300, 0);
  expect(win.drawn).toEqual(["Coat", "Right"]);
});
