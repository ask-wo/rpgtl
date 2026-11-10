import { test, expect } from "vite-plus/test";
import { loadRuntime } from "../testUtils/fixture.ts";

test("runtime draws translated MOG title commands as text centered on their pictures", async () => {
  const drawn: unknown[][] = [];
  class Bitmap {
    fontFace = "";
    fontSize = 0;
    textColor = "";
    listeners: (() => void)[] = [];
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    addLoadListener(listener: () => void) {
      this.listeners.push(listener);
    }
    measureTextWidth(text: string) {
      return text.length * 10;
    }
    drawText(...args: unknown[]) {
      drawn.push([this.textColor, ...args]);
    }
  }
  class Scene_Title {
    _commandWindow = { _list: [{ name: "New Game" }, { name: "致谢" }] };
    _com_position: ([number, number] | null)[] = [];
    _com_pictures: Bitmap[] = [];
    _com_sprites: { bitmap: Bitmap }[] = [];
    createPictureCommands() {
      this._com_position = [[700, 400], [650, 490], null];
      // A tall picture narrower than its English command, and a short wide one.
      this._com_pictures = [new Bitmap(60, 300), new Bitmap(150, 20)];
      this._com_sprites = this._com_pictures.map((bitmap) => ({ bitmap }));
    }
  }
  const $dataSystem: { rpgtlCommandsTranslated?: boolean } = {};
  await loadRuntime("MV", { Bitmap, Scene_Title, $dataSystem, Graphics: { width: 816 } });
  const load = (scene: Scene_Title) =>
    scene._com_pictures.forEach((picture) => picture.listeners.forEach((listener) => listener()));

  const untranslated = new Scene_Title();
  untranslated.createPictureCommands();
  expect(untranslated._com_pictures.map((picture) => picture.listeners.length)).toEqual([0, 0]);

  $dataSystem.rpgtlCommandsTranslated = true;
  const scene = new Scene_Title();
  scene.createPictureCommands();
  const [tall, wide] = scene._com_pictures;
  load(scene);
  const [first, second] = scene._com_pictures;
  expect(scene._com_sprites.map((sprite) => sprite.bitmap)).toEqual([first!, second!]);
  // "New Game" needs 88px, so the 60px picture grows by 28px around its center, and the
  // 10px halves of the short picture grow to one 40px line each.
  expect([first!.width, first!.height, first!.fontFace]).toEqual([88, 300, "GameFont"]);
  expect([second!.width, second!.height]).toEqual([150, 80]);
  // The selected look is the top half of the picture, the normal look the bottom half.
  expect(drawn.slice(0, 2)).toEqual([
    ["#ffb648", "New Game", 0, 55, 88, 40, "center"],
    ["#ffffff", "New Game", 0, 205, 88, 40, "center"],
  ]);
  expect(scene._com_position).toEqual([[686, 400], [650, 460], null]);
  expect([tall!.width, wide!.width]).toEqual([60, 150]);

  // A 218px name at 621 would end 31px past the 808px limit, which moves every command left.
  scene._commandWindow._list[0]!.name = "A much longer command";
  scene.createPictureCommands();
  load(scene);
  expect(scene._com_position).toEqual([[590, 400], [619, 460], null]);
});
