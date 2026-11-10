import type { ServedSystem } from "@rpgtl/contracts";

// The parts of the engine's classes and globals that the runtime touches, as the runtime sees them.

interface Named {
  name: string;
}
export interface Renderer {
  view: HTMLCanvasElement;
  resolution: number;
  render(...args: unknown[]): unknown;
  resize(width: number, height: number): void;
  // PIXI 4 keeps the screen's resolution here too, and its canvas renderer in rootResolution.
  rootRenderTarget?: { resolution: number; size: { width: number } };
  rootResolution?: number;
  // Filters render into their own textures: PIXI 4 (MV) through filterManager, PIXI 5 (MZ) filter.
  filterManager?: { pushFilter(target: unknown, filters: Filter[]): void };
  filter?: { push(target: unknown, filters: Filter[]): void };
  gl?: WebGLRenderingContext;
  _rpgtlSharpFilters?: boolean;
}
export type Filter = { resolution: number };
// A Bitmap drawn at a higher resolution than its size in game pixels, for sharp text.
export interface TextBitmap {
  _url?: string;
  _image?: unknown;
  _smooth?: boolean;
  _rpgtlScale?: number;
  _rpgtlWidth?: number;
  _rpgtlHeight?: number;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  _setDirty?(): void;
  // PIXI 5 (MZ) sizes textures with setRealSize; PIXI 4 (MV) with these fields.
  _baseTexture: {
    resolution: number;
    width: number;
    height: number;
    realWidth?: number;
    realHeight?: number;
    setRealSize?(width: number, height: number, resolution: number): void;
    update(): void;
  };
  resize(width: number, height: number): void;
  drawText(...args: unknown[]): void;
  blt(source: TextBitmap, ...args: number[]): void;
  getPixel(x: number, y: number): unknown;
  getAlphaPixel(x: number, y: number): unknown;
}
interface Actor {
  recoverAll(): void;
  addParam(id: number, bonus: number): void;
}
export interface TextWindow {
  contents: { width: number; height: number; fontSize: number };
  x?: number;
  width?: number;
  padding?: number;
  _wordWrap?: boolean;
  _rpgtlFontSize?: number | undefined;
  _rpgtlMessageLayout?: { start: number; top: number; bottom: number } | undefined;
  _textState?: { text?: string } | null;
  textWidth(text: string): number;
  resetFontSettings(): void;
  makeFontBigger?(): void;
  makeFontSmaller?(): void;
  calcTextHeight(state: { text: string; index: number }, all: boolean): number;
  newLineX?(state: { rtl: boolean }): number;
  textPadding?(): number;
  baseTextRect?(): { x: number; width: number };
  contentsWidth?(): number;
  contentsHeight?(): number;
  maxItems?(): number;
  _rpgtlWrap?: { start: number; max: number } | undefined;
  convertEscapeCharacters(text: string): string;
}
interface ItemListWindow extends TextWindow {
  width: number;
  _data?: (Named | null)[];
  _rpgtlColumns?: { data: unknown; width: number; columns: number };
  maxCols(): number;
  itemWidth(): number;
  lineHeight(): number;
  numberWidth?(): number;
}
export interface RpgMaker {
  SceneManager?: {
    run(...args: unknown[]): unknown;
    updateScene?(): void;
    updateInputData?(): void;
    isSceneChanging?(): boolean;
    initGraphics?(...args: unknown[]): unknown;
    push?(scene: new () => object): void;
    _scene?: object | null;
  };
  // Set by RPGTL before this script from the sharp pixels and sharp text settings.
  rpgtlSharpPixels?: boolean;
  rpgtlSharpText?: boolean;
  devicePixelRatio?: number;
  requestAnimationFrame(callback: () => void): unknown;
  performance: { now(): number };
  Scene_Map?: new () => object;
  Scene_Battle?: new () => object;
  Scene_Save?: new () => object;
  BattleManager?: { isInputting(): boolean };
  $gameMessage?: {
    isChoice(): boolean;
    isNumberInput(): boolean;
    isItemChoice(): boolean;
    isBusy?(): boolean;
  };
  // MV also has reserveBitmap and requestBitmap, which take the same first two arguments.
  ImageManager?: { iconWidth?: number } & Record<string, unknown>;
  Window_Message?: {
    prototype: TextWindow & {
      isTriggered(): boolean;
      newPage?(state: { x: number; y: number; startX?: number; startY?: number }): void;
      needsNewPage?(state: { y: number; height: number; index: number; text: string }): boolean;
    };
  };
  Window_ScrollText?: { prototype: TextWindow & { isFastForward(): boolean } };
  Window_BattleLog?: { prototype: { isFastForward(): boolean } };
  Window_Help?: { prototype: TextWindow };
  Window_Base?: {
    prototype: TextWindow & {
      drawFace(name: string, index: number, ...rest: unknown[]): void;
      drawTextEx(text: string, x: number, y: number, width?: number, ...rest: unknown[]): unknown;
      drawText(text: unknown, x: number, y: number, width?: number, align?: string): void;
      drawActorClass?(actor: { currentClass(): Named }, x: number, y: number, width?: number): void;
      drawItemName?(item: Named | null, x: number, y: number, width?: number): void;
    };
  };
  Window_ItemList?: { prototype: ItemListWindow };
  Window_ShopBuy?: {
    prototype: ItemListWindow & {
      drawItem(index: number): void;
      itemRect(index: number): { x: number; width: number };
      price(item: Named | null): number;
    };
  };
  Bitmap?: (new (width: number, height: number) => Bitmap) & { prototype: LoadingBitmap };
  // MV only; MZ decrypts images in Bitmap itself and has no retry screen of its own.
  Decrypter?: {
    _ignoreList: string[];
    _xhrOk: number;
    extToEncryptExt(url: string): string;
    decryptArrayBuffer(buffer: ArrayBuffer): ArrayBuffer;
    createBlobUrl(buffer: ArrayBuffer): string;
    decryptImg(url: string, bitmap: LoadingBitmap): void;
  };
  ResourceHandler?: {
    createLoader(
      url: string | null,
      retry: () => void,
      resign: () => void,
      intervals: number[],
    ): () => void;
  };
  // MV keeps its renderer in Graphics._renderer, MZ in Graphics._app.renderer.
  Graphics?: {
    width: number;
    _width?: number;
    _height?: number;
    _realScale?: number;
    _renderer?: Renderer;
    _app?: { renderer?: Renderer };
    _updateAllElements?(...args: unknown[]): unknown;
    _defaultStretchMode?(): boolean;
  };
  Scene_Title?: { prototype: Partial<PictureTitle> };
  StorageManager?: Record<string, unknown>;
  Game_Player?: { prototype: { executeEncounter(): boolean } };
  $gamePlayer?: { setThrough(value: boolean): void; isThrough(): boolean; canMove(): boolean };
  $gameParty?: {
    gold(): number;
    gainGold(amount: number): void;
    members(): Actor[];
    gainItem(item: Named, amount: number): void;
  };
  $gameActors: { actor(id: number): Actor | null };
  $gameVariables: { setValue(id: number, value: number): void };
  $gameSwitches: { setValue(id: number, value: boolean): void };
  $dataActors?: (Named | null)[];
  $dataItems?: (Named | null)[];
  $dataWeapons?: (Named | null)[];
  $dataArmors?: (Named | null)[];
  $dataSystem?: ServedSystem & {
    variables: string[];
    switches: string[];
    advanced?: { fallbackFonts?: string };
  };
  Game_Variables?: { prototype: { value(id: number): unknown } };
  Game_Actor?: { prototype: Record<"name" | "nickname" | "profile", () => unknown> };
  $gameSystem?: { mainFontFace?(): string; mainFontSize?(): number };
}
export interface Bitmap {
  width: number;
  height: number;
  addLoadListener(listener: () => void): void;
  fontFace: string;
  fontSize: number;
  textColor: string;
  measureTextWidth(text: string): number;
  drawText(text: string, x: number, y: number, width: number, height: number, align: string): void;
}
// The loading parts of Bitmap. `_requestImage`, `_loader` and the listeners exist only in MV.
export interface LoadingBitmap {
  _url: string;
  _image: HTMLImageElement;
  _decodeAfterRequest?: boolean;
  _loader?: () => void;
  _loadListener?: () => void;
  _errorListener?: () => void;
  _requestImage?(url: string): void;
  _onLoad(): void;
  _onError(): void;
  // The engine's states are strings. "loaded" and "none" are the ready ones.
  _loadingState: string;
  _callLoadListeners(): void;
  // MV marks the texture to be uploaded again; MZ updates it.
  _setDirty?(): void;
  _baseTexture?: { update(): void };
  context: CanvasRenderingContext2D;
  // MZ only.
  destroy?(): void;
}
// Scene_Title as MOG_TitlePictureCom changes it: one picture per command, the selected
// look in its top half and the normal look in its bottom half.
export interface PictureTitle {
  createPictureCommands(): void;
  _commandWindow: { _list: { name: string }[] };
  _com_position: ([number, number] | null)[];
  _com_pictures: Bitmap[];
  _com_sprites: { bitmap: Bitmap }[];
}

export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`${url} could not be loaded`));
    image.src = url;
  });

export const rm = window as unknown as RpgMaker;
export const gameId = document.currentScript?.dataset.game;
