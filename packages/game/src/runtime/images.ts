import type { ImageTextHint } from "@rpgtl/contracts";
import { letteringFace } from "../letteringFonts.ts";
import { drawImageText } from "../lettering.ts";
import { type LoadingBitmap, type TextBitmap, describeError, loadImage, rm } from "./engine.ts";
import { reportMissing } from "./missingFiles.ts";
import { renderScale, rescale } from "./sharpRendering.ts";

// A missing image shows as this transparent pixel instead of stopping the game with a loading
// error, such as an event that asks for a face which only exists as a character sprite.
const blankImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export function hookMissingImages() {
  // Images to load in place of the ones the game asks for, by folder and name.
  for (const method of ["loadBitmap", "reserveBitmap", "requestBitmap"]) {
    const load = rm.ImageManager?.[method];
    if (typeof load !== "function") continue;
    rm.ImageManager![method] = function (
      this: unknown,
      folder: string,
      name: string,
      ...rest: unknown[]
    ) {
      const replacement = rm.$dataSystem?.rpgtlImages?.[folder + name];
      return load.call(this, folder, replacement ? replacement.file : name, ...rest);
    };
  }
  const { Bitmap, Decrypter, ResourceHandler } = rm;
  const proto = Bitmap?.prototype;
  if (!proto) return;
  const onError = proto._onError;
  // MV's own version ignores a failed request, so a missing encrypted image left the game
  // waiting forever on its loading screen. This one treats it like an image that failed to load.
  if (Decrypter)
    Decrypter.decryptImg = function (url, bitmap) {
      const fail = () => (bitmap._loader ?? bitmap._onError.bind(bitmap))();
      const xhr = new XMLHttpRequest();
      xhr.open("GET", Decrypter.extToEncryptExt(url));
      xhr.responseType = "arraybuffer";
      xhr.onload = () => {
        if (xhr.status >= Decrypter._xhrOk || !xhr.response) return fail();
        bitmap._image.src = Decrypter.createBlobUrl(Decrypter.decryptArrayBuffer(xhr.response));
        bitmap._image.addEventListener("load", (bitmap._loadListener = proto._onLoad.bind(bitmap)));
        bitmap._image.addEventListener("error", (bitmap._errorListener = fail));
      };
      xhr.onerror = fail;
      xhr.send();
    };

  // MZ and MV before 1.5 load the image themselves, without `_requestImage`.
  const requestImage = proto._requestImage;
  if (!requestImage || !Decrypter || !ResourceHandler) {
    proto._onError = function (this: LoadingBitmap) {
      if (this._image.src === blankImage) return onError.call(this);
      reportMissing(this._url, "image");
      this._image = new Image();
      this._image.onload = this._onLoad.bind(this);
      this._image.onerror = onError.bind(this);
      this._image.src = blankImage;
    };
    return;
  }

  Decrypter._ignoreList.push(blankImage);
  // MV retries a failed image for 4.5 seconds and then shows its retry screen. A missing
  // local file stays missing, so give up at once and show it blank.
  proto._requestImage = function (this: LoadingBitmap, url: string) {
    if (this._decodeAfterRequest && !this._loader)
      this._loader = ResourceHandler.createLoader(
        null,
        () => this._requestImage!(url),
        () => this._onError(),
        [],
      );
    requestImage.call(this, url);
  };
  proto._onError = function (this: LoadingBitmap) {
    if (this._url === blankImage) return onError.call(this);
    reportMissing(this._url, "image");
    this._requestImage!(blankImage);
  };
}

// The font the game draws its text in. Title and system images load before `$gameSystem` exists,
// so MZ's choice is made here the way its `Game_System.mainFontFace` makes it.
function gameFont() {
  const { $gameSystem, $dataSystem } = rm;
  return (
    $gameSystem?.mainFontFace?.() ??
    ($dataSystem?.advanced
      ? `rmmz-mainfont, ${$dataSystem.advanced.fallbackFonts ?? "sans-serif"}`
      : "GameFont")
  );
}

// Images the player sees with the English drawn in. The bitmap is not ready until it is drawn, so
// the game never shows the Chinese first.
export function hookImageText() {
  const proto = rm.Bitmap?.prototype;
  const callLoadListeners = proto?._callLoadListeners;
  if (!proto || typeof callLoadListeners !== "function") return;
  // Plugins may ask for a file in other letter case than its name, such as Ryo_SceneShop's
  // Com_0 for com_0, which Windows and RPGTL's server load all the same.
  let lowerCaseOf: Record<string, ImageTextHint> | undefined;
  let byLowerCase = new Map<string, ImageTextHint>();
  const findHint = (name: string) => {
    const hints = rm.$dataSystem?.rpgtlImageText;
    if (!hints) return undefined;
    if (Object.hasOwn(hints, name)) return hints[name];
    if (lowerCaseOf !== hints) {
      lowerCaseOf = hints;
      byLowerCase = new Map(
        Object.entries(hints).map(([image, hint]) => [image.toLowerCase(), hint]),
      );
    }
    return byLowerCase.get(name.toLowerCase());
  };
  // A scene may destroy a bitmap while its English is still being drawn.
  const destroyed = new WeakSet<LoadingBitmap>();
  const { destroy } = proto;
  if (destroy)
    proto.destroy = function (this: LoadingBitmap) {
      destroyed.add(this);
      destroy.call(this);
    };
  proto._callLoadListeners = function (this: LoadingBitmap) {
    const name = /^(?:\.\/)?(img\/.+?)\.png(?:\?.*)?$/i.exec(this._url ?? "")?.[1];
    let hint: ImageTextHint | undefined;
    try {
      hint = name === undefined ? undefined : findHint(decodeURIComponent(name));
    } catch {}
    if (!hint) return callLoadListeners.call(this);
    const { erased, blocks, font, series } = hint;
    const face = font ? letteringFace(font) : gameFont();
    this._loadingState = "rpgtl-drawing";
    const finish = () => {
      if (destroyed.has(this)) return;
      this._loadingState = "loaded";
      callLoadListeners.call(this);
    };
    void Promise.all([
      loadImage(erased),
      ...[false, true].map((bold) => {
        const text = blocks
          .filter((block) => block.bold === bold)
          .map((block) => block.text)
          .join("");
        return text ? document.fonts?.load(`${bold ? "bold " : ""}20px ${face}`, text) : undefined;
      }),
    ])
      .then(([image]) => {
        if (destroyed.has(this)) return;
        // With sharp text the English is drawn at the screen's resolution, like other text.
        if (rm.rpgtlSharpText && renderScale() > 1)
          rescale(this as unknown as TextBitmap, renderScale());
        drawImageText(this.context, image, blocks, face, series);
        if (this._setDirty) this._setDirty();
        else this._baseTexture?.update();
      })
      .catch((error) =>
        console.warn(`RPGTL: ${name} could not be drawn in English: ${describeError(error)}`),
      )
      .then(finish);
  };
}
