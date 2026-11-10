import { type PictureTitle, rm } from "./engine.ts";

// MOG_TitlePictureCom shows title commands as pictures, whose words stay in the original
// language. Once the commands are translated, draw them as text centered where each picture was.
export function hookTitleCommands() {
  const title = rm.Scene_Title?.prototype;
  const create = title?.createPictureCommands;
  if (!title || !create) return;
  title.createPictureCommands = function (this: PictureTitle) {
    create.call(this);
    const { Bitmap, $dataSystem, $gameSystem } = rm;
    if (!Bitmap || !$dataSystem?.rpgtlCommandsTranslated) return;
    // The pictures are drawn in English themselves, and mixing both would look inconsistent.
    if (
      Object.keys($dataSystem.rpgtlImageText ?? {}).some((image) =>
        /^img\/titles2\/Command_\d+$/.test(image),
      )
    )
      return;
    const face = $gameSystem?.mainFontFace?.() ?? "GameFont";
    const size = $gameSystem?.mainFontSize?.() ?? 28;
    const lineHeight = size + 12;
    // English commands can be wider than the pictures, so move them all left by the same
    // amount when one would run past the right edge of the screen.
    const right = (rm.Graphics?.width ?? 816) - 8;
    let overflow = 0;
    let waiting = this._commandWindow._list.length;
    this._commandWindow._list.forEach(({ name }, index) => {
      const picture = this._com_pictures[index]!;
      // MOG places each picture by its size, which is known once it has loaded. The scene
      // waits for that before it shows the commands.
      picture.addLoadListener(() => {
        const probe = new Bitmap(1, 1);
        probe.fontFace = face;
        probe.fontSize = size;
        const textWidth = Math.ceil(probe.measureTextWidth(name)) + 8;
        const width = Math.max(picture.width, textWidth);
        const half = Math.max(Math.floor(picture.height / 2), lineHeight);
        const bitmap = new Bitmap(width, half * 2);
        bitmap.fontFace = face;
        bitmap.fontSize = size;
        const top = Math.floor((half - lineHeight) / 2);
        bitmap.textColor = "#ffb648";
        bitmap.drawText(name, 0, top, width, lineHeight, "center");
        bitmap.textColor = "#ffffff";
        bitmap.drawText(name, 0, half + top, width, lineHeight, "center");
        this._com_pictures[index] = bitmap;
        this._com_sprites[index]!.bitmap = bitmap;
        const position = this._com_position[index];
        if (position) {
          position[0] -= (width - picture.width) / 2;
          position[1] -= (bitmap.height - picture.height) / 2;
          overflow = Math.max(overflow, position[0] + width - right);
        }
        if (--waiting === 0)
          for (const other of this._com_position) if (other) other[0] -= overflow;
      });
    });
  };
}
