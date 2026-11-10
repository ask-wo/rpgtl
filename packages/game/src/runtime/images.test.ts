import { test, expect } from "vite-plus/test";
import { loadRuntime } from "../testUtils/fixture.ts";

test("runtime loads the image System.json names in place of the one the game asks for", async () => {
  const loaded: unknown[][] = [];
  const ImageManager = {
    loadBitmap: (...args: unknown[]) => loaded.push(args),
    reserveBitmap: (...args: unknown[]) => loaded.push(args),
  };
  const $dataSystem = {
    rpgtlImages: { "img/battlecommands/Com_Magic": { file: "Com_魔法技能" } },
  };
  await loadRuntime("MV", { ImageManager, $dataSystem });
  ImageManager.reserveBitmap("img/battlecommands/", "Com_Magic", 0, true, 1);
  ImageManager.loadBitmap("img/battlecommands/", "Com_Attack", 0, true);
  ImageManager.loadBitmap("img/pictures/", "Com_Magic", 0, false);
  expect(loaded).toEqual([
    ["img/battlecommands/", "Com_魔法技能", 0, true, 1],
    ["img/battlecommands/", "Com_Attack", 0, true],
    ["img/pictures/", "Com_Magic", 0, false],
  ]);
});

test("runtime finds the English for an image asked for in other letter case", async () => {
  const hint = { erased: "data:image/png;base64,", blocks: [] };
  const called: string[] = [];
  class Bitmap {
    _url = "";
    _loadingState = "";
    _callLoadListeners() {
      called.push(this._url);
    }
  }
  await loadRuntime("MV", {
    Bitmap,
    $dataSystem: { rpgtlImageText: { "img/menus/shop/com_0": hint } },
  });
  const bitmap = new Bitmap();
  bitmap._url = "img/menus/shop/Com_0.png";
  bitmap._callLoadListeners();
  expect(bitmap._loadingState).toBe("rpgtl-drawing");
  const other = new Bitmap();
  other._url = "img/menus/shop/Com_1.png";
  other._callLoadListeners();
  expect(called).toEqual(["img/menus/shop/Com_1.png"]);
});

test("runtime shows a missing image blank instead of the loading error in MZ", async () => {
  const blank = /^data:image\/png;base64,/;
  const warn = console.warn;
  const image = globalThis.Image;
  console.warn = () => {};
  globalThis.Image = class {
    src = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
  } as never;
  try {
    class Bitmap {
      _url = "img/faces/%24Arlene.png";
      _image = new Image();
      _loadingState = "loading";
      _onLoad() {
        this._loadingState = "loaded";
      }
      _onError() {
        this._loadingState = "error";
      }
    }
    await loadRuntime("MZ", { Bitmap });
    const bitmap = new Bitmap();
    bitmap._onError();
    expect(bitmap._loadingState).toBe("loading");
    expect(bitmap._image.src).toMatch(blank);
    (bitmap._image.onload as () => void)();
    expect(bitmap._loadingState).toBe("loaded");

    // The blank image itself failing ends in the engine's own error.
    const broken = new Bitmap();
    broken._onError();
    (broken._image.onerror as () => void)();
    expect(broken._loadingState).toBe("error");
  } finally {
    console.warn = warn;
    globalThis.Image = image;
  }
});

test("runtime gives up on a missing image at once and shows it blank in MV", async () => {
  const warn = console.warn;
  const xhr = globalThis.XMLHttpRequest;
  console.warn = () => {};
  const requests: { url: string; status: number; onload(): void }[] = [];
  globalThis.XMLHttpRequest = class {
    url = "";
    status = 404;
    onload = () => {};
    open(_: string, url: string) {
      this.url = url;
    }
    send() {
      requests.push(this);
    }
  } as never;
  try {
    const Decrypter = {
      _ignoreList: [] as string[],
      _xhrOk: 400,
      extToEncryptExt: (url: string) => url.replace(/\.png$/, ".rpgmvp"),
      decryptImg: (() => {}) as (url: string, bitmap: Bitmap) => void,
    };
    const intervals: number[][] = [];
    const ResourceHandler = {
      createLoader(_: null, __: () => void, resign: () => void, retries: number[]) {
        intervals.push(retries);
        return resign;
      },
    };
    class Bitmap {
      _url = "";
      _decodeAfterRequest = true;
      _loader?: () => void;
      _loadingState = "";
      _requestImage(url: string) {
        this._url = url;
        this._loadingState = "decrypting";
        if (!Decrypter._ignoreList.includes(url)) Decrypter.decryptImg(url, this);
      }
      _onLoad() {}
      _onError() {
        this._loadingState = "error";
      }
    }
    await loadRuntime("MV", { Bitmap, Decrypter, ResourceHandler });

    // MV's own decryptImg ignores a 404, which left the game waiting in the browser.
    const bitmap = new Bitmap();
    bitmap._requestImage("img/faces/%24Arlene.png");
    expect(intervals).toEqual([[]]);
    expect(requests.map((request) => request.url)).toEqual(["img/faces/%24Arlene.rpgmvp"]);
    requests[0]!.onload();
    expect(bitmap._url).toMatch(/^data:image\/png;base64,/);
    expect(bitmap._loadingState).toBe("decrypting");
  } finally {
    console.warn = warn;
    globalThis.XMLHttpRequest = xhr;
  }
});

test("runtime shows a missing encrypted image blank in MV before 1.5", async () => {
  const warn = console.warn;
  const xhr = globalThis.XMLHttpRequest;
  const image = globalThis.Image;
  console.warn = () => {};
  const requests: { url: string; status: number; onload(): void; onerror(): void }[] = [];
  globalThis.XMLHttpRequest = class {
    url = "";
    status = 0;
    response = null;
    onload = () => {};
    onerror = () => {};
    open(_: string, url: string) {
      this.url = url;
    }
    send() {
      requests.push(this);
    }
  } as never;
  globalThis.Image = class {
    src = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
  } as never;
  try {
    const Decrypter = {
      _ignoreList: [] as string[],
      _xhrOk: 400,
      extToEncryptExt: (url: string) => url.replace(/\.png$/, ".rpgmvp"),
      decryptImg: (() => {}) as (url: string, bitmap: Bitmap) => void,
    };
    // MV 1.3's Bitmap: Bitmap.load hands encrypted images to decryptImg, which only ever
    // reported success, so a missing one kept the loading screen up forever.
    class Bitmap {
      _url = "img/pictures/Sign.png";
      _image = new Image();
      _loadingState = "loading";
      _onLoad() {
        this._loadingState = "loaded";
      }
      _onError() {
        this._loadingState = "error";
      }
    }
    await loadRuntime("MV", { Bitmap, Decrypter });

    for (const end of ["onerror", "onload"] as const) {
      const bitmap = new Bitmap();
      Decrypter.decryptImg(bitmap._url, bitmap);
      expect(requests.at(-1)!.url).toBe("img/pictures/Sign.rpgmvp");
      requests.at(-1)![end]();
      expect(bitmap._image.src).toMatch(/^data:image\/png;base64,/);
      (bitmap._image.onload as () => void)();
      expect(bitmap._loadingState).toBe("loaded");
    }
  } finally {
    console.warn = warn;
    globalThis.XMLHttpRequest = xhr;
    globalThis.Image = image;
  }
});

test("runtime leaves a bitmap destroyed while its English is drawn alone in MZ", async () => {
  const image = globalThis.Image;
  const images: { onload: () => void }[] = [];
  globalThis.Image = class {
    onload = () => {};
    constructor() {
      images.push(this);
    }
  } as never;
  try {
    const called: string[] = [];
    let drawn = false;
    class Bitmap {
      _url = "img/menus/Start.png";
      _loadingState = "";
      get context() {
        drawn = true;
        return undefined;
      }
      destroy() {}
      _callLoadListeners() {
        called.push(this._url);
      }
    }
    await loadRuntime("MZ", {
      Bitmap,
      $dataSystem: { rpgtlImageText: { "img/menus/Start": { erased: "erased.png", blocks: [] } } },
    });
    const bitmap = new Bitmap();
    bitmap._callLoadListeners();
    bitmap.destroy();
    images[0]!.onload();
    // The drawing continues in promise callbacks, which all run before the next macrotask.
    await new Promise((resolve) => setImmediate(resolve));
    expect(bitmap._loadingState).toBe("rpgtl-drawing");
    expect(drawn).toBe(false);
    expect(called).toEqual([]);
  } finally {
    globalThis.Image = image;
  }
});
