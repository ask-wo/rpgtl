import { type Bitmap, rm } from "./engine.ts";

// HUD plugins draw actor names straight onto a bitmap whose frame is a separate picture sized for
// the original name. A name much wider than the original there is drawn by its short form;
// windows already squeeze text to the width they pass.
export function hookShortNames() {
  const bitmap = rm.Bitmap?.prototype as unknown as Bitmap | undefined;
  const base = rm.Window_Base?.prototype as Record<string, unknown> | undefined;
  if (!bitmap?.drawText || !base) return;
  let inWindow = 0;
  for (const method of ["drawText", "drawTextEx"] as const) {
    const original = base[method];
    if (typeof original !== "function") continue;
    base[method] = function (this: unknown, ...args: unknown[]) {
      inWindow++;
      try {
        return (original as (...args: unknown[]) => unknown).apply(this, args);
      } finally {
        inWindow--;
      }
    };
  }
  const { drawText } = bitmap;
  bitmap.drawText = function (this: Bitmap, text, ...rest) {
    const name = rm.$dataSystem?.rpgtlShortNames?.[String(text)];
    const tooWide =
      name &&
      !inWindow &&
      this.measureTextWidth(String(text)) > 1.3 * this.measureTextWidth(name.source);
    return drawText.call(this, tooWide ? name.short : text, ...rest);
  };
}

// Status screens such as MOG_SceneStatus place the class name in art that leaves room for the
// original only, but pass MV's default width of 168px. A translation wider than the original is
// drawn in a smaller font that fits the original's width, down to 70% of the size, and squeezed
// only below that.
export function hookClassNames() {
  const base = rm.Window_Base?.prototype;
  const drawActorClass = base?.drawActorClass;
  if (!base || !drawActorClass) return;
  base.drawActorClass = function (actor, x, y, width) {
    const name = actor.currentClass().name;
    const source = rm.$dataSystem?.rpgtlClassNames?.[name];
    const room = source === undefined ? 0 : this.textWidth(source) + 6;
    const natural = room && this.textWidth(name);
    if (natural <= room) return drawActorClass.call(this, actor, x, y, width);
    const size = this.contents.fontSize;
    this.contents.fontSize = Math.max(Math.floor((size * room) / natural), Math.ceil(size * 0.7));
    try {
      drawActorClass.call(this, actor, x, y, Math.min(width || 168, room));
    } finally {
      this.contents.fontSize = size;
    }
  };
}

// An item list squeezes a name to the width it passes, which leaves long English unreadable.
// Such a name is drawn in a smaller font, down to 70% of the size, and squeezed only below that.
export function hookItemNames() {
  const base = rm.Window_Base?.prototype;
  const drawItemName = base?.drawItemName;
  const drawText = base?.drawText;
  if (!base || !drawItemName || !drawText) return;
  // The name being drawn, and the x where the text after it begins, if a hook knows.
  let name: string | undefined;
  let end = Infinity;
  base.drawItemName = function (item, x, y, width) {
    const outer = name;
    name = item?.name;
    try {
      return drawItemName.call(this, item, x, y, width);
    } finally {
      name = outer;
    }
  };
  base.drawText = function (text, x, y, width, align) {
    if (name === undefined || text !== name || !width || width <= 0)
      return drawText.call(this, text, x, y, width, align);
    name = undefined;
    const room = Math.min(width, end - x);
    const natural = this.textWidth(String(text));
    const size = this.contents.fontSize;
    if (natural > room)
      this.contents.fontSize = Math.max(Math.floor((size * room) / natural), Math.ceil(size * 0.7));
    try {
      return drawText.call(this, text, x, y, room, align);
    } finally {
      this.contents.fontSize = size;
    }
  };

  // YEP_CoreEngine's shop list passes the whole row for the name, which fits the original but
  // lets English run under the price, so the name ends where the price begins.
  const shop = rm.Window_ShopBuy?.prototype;
  const drawItem = shop?.drawItem;
  if (shop && drawItem)
    shop.drawItem = function (index) {
      const rect = this.itemRect(index);
      const price = String(this.price(this._data?.[index] ?? null));
      const padding = this.textPadding?.() ?? 6;
      end = rect.x + rect.width - 2 * padding - this.textWidth(price);
      try {
        return drawItem.call(this, index);
      } finally {
        end = Infinity;
      }
    };

  // Ryo_SceneShop narrows the sell window to 370px but keeps its two columns, which leaves a
  // name 90px. A list whose widest name would still be squeezed at 70% shows one column.
  const list = rm.Window_ItemList?.prototype;
  const maxCols = list?.maxCols;
  if (!list || !maxCols) return;
  let measuring = false;
  list.maxCols = function () {
    const columns = maxCols.call(this);
    if (columns <= 1 || measuring || !this._data) return columns;
    const known = this._rpgtlColumns;
    if (known?.data === this._data && known.width === this.width) return known.columns;
    measuring = true;
    let room: number;
    try {
      room = this.itemWidth() - (this.numberWidth?.() ?? 0) - this.lineHeight();
    } finally {
      measuring = false;
    }
    const widest = Math.max(0, ...this._data.map((item) => (item ? this.textWidth(item.name) : 0)));
    const fits = widest * 0.7 <= room;
    this._rpgtlColumns = { data: this._data, width: this.width, columns: fits ? columns : 1 };
    return fits ? columns : 1;
  };
}

// Plugins hide text by drawing it left of the window, such as MOG_SceneStatus's equipment at
// x -300. Windows squeeze text to the width they pass, so a translation longer than the
// original reaches further right, and its end comes into view. Text drawn more than half left
// of the window stays hidden.
export function hookHiddenText() {
  const base = rm.Window_Base?.prototype;
  const drawText = base?.drawText;
  if (!base || !drawText) return;
  base.drawText = function (text, x, y, width, align) {
    if (x < 0) {
      // Feng_ItemColors and others colour names with \C[n] that they remove before drawing.
      const natural = this.textWidth(String(text).replace(/\\c\[\d+\]/gi, ""));
      const drawn = width && width > 0 ? Math.min(natural, width) : natural;
      const room = width && width > 0 ? width - drawn : 0;
      const left = x + (align === "center" ? room / 2 : align === "right" ? room : 0);
      if (left + drawn / 2 < 0) return;
    }
    return drawText.call(this, text, x, y, width, align);
  };
}
