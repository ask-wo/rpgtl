import { spriteColor } from "../../../../packages/game/src/testUtils/fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import { entryTranslation } from "../../../../packages/domain/src/guesses.ts";
import path from "node:path";

// Run with verify-rpgtl/scripts/drive.ts against an MV or MZ fixture only.
async function measureDraw(game: any, log: (line: string) => void) {
  await game.eval(() => {
    const w = window as any;
    const template = w.$gameMap.events()[0];
    const events = Array.from({ length: 300 }, (_, i) => ({
      ...template,
      eventId: () => i + 1,
      x: i % 200,
      y: Math.floor(i / 200) + 10,
    }));
    w.$dataMap = {
      width: 200,
      height: 200,
      tilesetId: 1,
      displayName: "Performance",
      data: Array.from({ length: 240000 }, () => 1),
      events: [],
    };
    w.$gameMap.width = () => 200;
    w.$gameMap.height = () => 200;
    w.$gameMap.events = () => events;
    const canvas = document
      .querySelector("#rpgtl-map-view")!
      .shadowRoot!.querySelector("#map") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const blit = ctx.drawImage.bind(ctx);
    const clear = ctx.clearRect.bind(ctx);
    // The grid is the first image drawn after each clear; every later one is a sprite.
    let gridNext = false;
    ctx.clearRect = (...args) => {
      gridNext = true;
      clear(...args);
    };
    ctx.drawImage = (...args: any[]) => {
      if (gridNext) {
        w.gridBounds = args.slice(1);
        w.spriteDraws = 0;
      } else w.spriteDraws++;
      gridNext = false;
      (blit as any)(...args);
    };
    const raf = window.requestAnimationFrame.bind(window);
    w.drawTimes = [];
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const start = performance.now();
        callback(time);
        if (callback.name === "tick") w.drawTimes.push(performance.now() - start);
      });
  });
  await game.press("F7");
  await game.waitFor("#rpgtl-map-view");
  await game.eval(() => new Promise((resolve) => setTimeout(resolve, 250)));
  await game.eval(() => {
    (window as any).drawTimes = [];
  });
  await game.eval(() => new Promise((resolve) => setTimeout(resolve, 2000)));
  const timing = await game.eval(() => {
    const times = (window as any).drawTimes;
    return {
      frames: times.length,
      average: times.reduce((a: number, b: number) => a + b, 0) / times.length,
    };
  });
  log(`draw timing: ${JSON.stringify(timing)}`);
  if (!timing.frames || timing.average >= 16.7)
    throw new Error("Sprite redraw must average below 16.7ms");
  if ((await game.eval("spriteDraws")) !== 300)
    throw new Error("All 300 performance events must draw loaded sprites");
  log("PASS redraw with sprites on all 300 events stays below 16.7ms");
  const fit = await game.eval(() => {
    const w = window as any;
    const canvas = document.querySelector("#rpgtl-map-view")!.shadowRoot!.querySelector("#map")!;
    const r = canvas.getBoundingClientRect();
    const [x, y, width, height] = w.gridBounds;
    return x >= 0 && y >= 0 && x + width <= r.width && y + height <= r.height;
  });
  if (!fit) throw new Error("200x200 grid must fit fully inside the viewport");
  log("PASS 200x200 grid fits fully inside the viewport");
  await game.shot("performance-200x200-fit");
  const mapBox = await game.eval(() => {
    const r = document
      .querySelector("#rpgtl-map-view")!
      .shadowRoot!.querySelector("#map")!
      .getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const fitWidth = await game.eval("gridBounds[2]");
  const frame = () =>
    game.eval(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  await game.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...mapBox,
    deltaX: 0,
    deltaY: -600,
  });
  await frame();
  if ((await game.eval("gridBounds[2]")) <= fitWidth) throw new Error("Wheel must zoom in");
  await game.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...mapBox,
    deltaX: 0,
    deltaY: 100000,
  });
  await frame();
  if (Math.abs((await game.eval("gridBounds[2]")) - fitWidth) > 0.01)
    throw new Error("Wheel minimum must return to fit scale");
  const startX = await game.eval("gridBounds[0]");
  await game.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...mapBox,
    button: "left",
    clickCount: 1,
  });
  await game.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: mapBox.x + 30,
    y: mapBox.y + 10,
    button: "left",
    buttons: 1,
  });
  await game.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: mapBox.x + 30,
    y: mapBox.y + 10,
    button: "left",
    clickCount: 1,
  });
  await frame();
  if (Math.abs((await game.eval("gridBounds[0]")) - startX - 30) > 0.01)
    throw new Error("Dragging must pan the grid");
  log("PASS wheel zooms down to fit scale and dragging pans");
}
export default async ({ page, openPage, run, log }: any) => {
  const assert = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    log("PASS " + message);
  };
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  await page.shot("workspace-unchanged");
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  await page.click('label[for="translate-game"]');
  await page.waitFor('a[href$="/text"]');
  await page.click('a[href$="/text"]');
  const names = [
    ["客人1号", "Guest"],
    ["门开了", "Door is open"],
    ["任务进度", "Quest progress"],
  ];
  for (const [source, translation] of names)
    await page.fill(page.labelled(`English for ${source}`, "textarea"), translation!);
  await page.shot("names-edited");
  const saved = async () =>
    JSON.parse(await readFile(path.join(run.state, "games", id, "catalog.json"), "utf8"));
  const allSaved = (catalog: any) =>
    names.every(([source, translation]) =>
      catalog.entries.some(
        (entry: any) => entry.source === source && entryTranslation(entry) === translation,
      ),
    );
  let savedCatalog = await saved();
  for (let tries = 0; !allSaved(savedCatalog); tries++) {
    if (tries > 50) throw new Error("The catalog did not save the names");
    await new Promise((resolve) => setTimeout(resolve, 100));
    savedCatalog = await saved();
  }
  await page.waitUntil(`document.body.textContent.includes("All changes saved")`);
  await page.shot("names-saved");
  await writeFile(run.evidence + "/catalog-names.json", JSON.stringify(savedCatalog, null, 2));
  const game = await openPage("/game/" + id + "/");
  await game.waitUntil('!!window.$gameMap && !!document.querySelector("#rpgtl-map-view")');
  const servedNames = await game.eval(async () => {
    const map = await (await fetch("data/Map001.json")).json();
    const system = await (await fetch("data/System.json")).json();
    (window as any).$dataMap.rpgtlNames = map.rpgtlNames;
    (window as any).$dataSystem.rpgtlNames = system.rpgtlNames;
    return { map: map.rpgtlNames, system: system.rpgtlNames };
  });
  if (
    JSON.stringify(servedNames) !==
    JSON.stringify({
      map: { events: { "1": "Guest" } },
      system: { switches: { "1": "Door is open" }, variables: { "1": "Quest progress" } },
    })
  )
    throw new Error("Served game data did not include the saved name translations");
  await writeFile(
    run.evidence + "/served-Map001.json",
    JSON.stringify(await game.eval('fetch("data/Map001.json").then(r=>r.json())'), null, 2),
  );
  await writeFile(
    run.evidence + "/served-System.json",
    JSON.stringify(await game.eval('fetch("data/System.json").then(r=>r.json())'), null, 2),
  );
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 816,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const root = 'document.querySelector("#rpgtl-map-view").shadowRoot';
  const read = (selector: string, prop = "textContent") =>
    game.eval(`${root}.querySelector(${JSON.stringify(selector)})?.${prop}`);
  const visible = () => game.eval('!document.querySelector("#rpgtl-map-view").hidden');
  const pause = () =>
    game.eval(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  async function click(selector: string, scope = root) {
    const box = await game.eval(
      `(() => { const el = ${scope}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`,
    );
    if (!box) throw new Error(`${selector} is hidden`);
    for (const type of ["mousePressed", "mouseReleased"])
      await game.send("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
    log("click shadow " + selector);
    await pause();
  }
  async function clickTile(x: number, y: number, width: number, height: number) {
    const box = await game.eval(
      `(() => { const r=${root}.querySelector('#map').getBoundingClientRect(); const [left,top,mapWidth,mapHeight]=mapGridDraw; const tX=mapWidth/${width}; const tY=mapHeight/${height}; return {x:r.x+left+(${x}+.5)*tX,y:r.y+top+(${y}+.5)*tY}; })()`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await game.send("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
    await pause();
  }
  await game.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  assert(await game.eval("!!heldGameKeys.ArrowRight"), "stub records the held movement key");
  await game.eval(
    "$gameMap.events()[0].event().pages[0].conditions.variableValid = true; $gameMap.events()[0].event().pages[0].conditions.variableId = 1; $gameMap.events()[0].event().pages[0].conditions.switch1Valid = true; $gameMap.events()[0].event().pages[0].conditions.switch1Id = 1;",
  );
  await game.eval(() => {
    const firstPage = (window as any).$gameMap.events()[0].event().pages[0];
    firstPage.list = [
      { code: 101, indent: 0, parameters: ["", 0, 0, 2, ""] },
      {
        code: 401,
        indent: 0,
        parameters: ["\\n<Guide>\\C[2]Race\\C[0]: \\V[102]\\{!\\}"],
      },
      { code: 401, indent: 0, parameters: ["\\N[1] has 50\\G \\I[64]\\Custom[3]"] },
      { code: 355, indent: 0, parameters: ["const role = $gameVariables.value(104);"] },
      { code: 655, indent: 0, parameters: ["$gameVariables.value(1);"] },
      { code: 655, indent: 0, parameters: ["$gameVariables.setValue(117, 0);"] },
      { code: 655, indent: 0, parameters: [`const longValue = "${"x".repeat(120)}";`] },
      ...firstPage.list.slice(3),
    ];
    (window as any).$dataSystem.currencyUnit = "Gold";
    (window as any).$dataSystem.variables[104] = "职业";
    (window as any).$dataSystem.variables[117] = "Target";
    (window as any).$gameVariables.setValue(102, "Human");
    (window as any).$gameVariables.setValue(1, 3);
    (window as any).$gameVariables.setValue(104, "Teacher");
    (window as any).$gameVariables.setValue(117, 0);
  });
  await game.eval(() => {
    const w = window as any;
    const ctx = document
      .querySelector<HTMLCanvasElement>("#rpgtl-map-view")!
      .shadowRoot!.querySelector<HTMLCanvasElement>("#map")!
      .getContext("2d")!;
    const draw = ctx.drawImage.bind(ctx);
    const clear = ctx.clearRect.bind(ctx);
    // The grid is the first image drawn after each clear.
    let gridNext = false;
    ctx.clearRect = (...args) => {
      gridNext = true;
      clear(...args);
    };
    ctx.drawImage = (...args: any[]) => {
      if (gridNext) w.mapGridDraw = args.slice(1, 5);
      gridNext = false;
      (draw as any)(...args);
    };
  });
  await game.press("F7");
  assert(await visible(), "F7 opens the view");
  await game.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  assert(
    await game.eval(
      '!heldGameKeys.ArrowRight && gameKeyUps.includes("ArrowRight") && Input.clearCalls > 0 && TouchInput.clearCalls > 0',
    ),
    "opening clears input and keyup reaches the engine",
  );
  const count = await game.eval("gameKeys.length");
  await game.press("ArrowLeft");
  assert((await game.eval("gameKeys.length")) === count, "movement keydown is isolated");
  await game.waitUntil(
    '["People1", "$Big", "Actor1"].every(name => ImageManager.loadCharacter(name).isReady())',
  );
  await pause();
  async function markerPixel(markerId: number, expected: number[], above = false) {
    const color = await game.eval(
      (eventId: number, sampleAbove: boolean) => {
        const w = window as any;
        const canvas = document
          .querySelector("#rpgtl-map-view")!
          .shadowRoot!.querySelector<HTMLCanvasElement>("#map")!;
        const markerEvent = w.$gameMap
          .events()
          .find((candidate: any) => candidate.eventId() === eventId);
        const [left, top, width] = w.mapGridDraw;
        const tile = width / w.$dataMap.width;
        return [
          ...canvas
            .getContext("2d")!
            .getImageData(
              Math.floor(left + (markerEvent.x + 0.25) * tile),
              Math.floor(top + (markerEvent.y + (sampleAbove ? -0.5 : 0.25)) * tile),
              1,
              1,
            ).data,
        ];
      },
      markerId,
      above,
    );
    assert(
      JSON.stringify(color) === JSON.stringify(expected),
      `event ${markerId} ${above ? "above-tile " : ""}sprite pixel ${color} matches ${expected}`,
    );
  }
  await markerPixel(1, spriteColor(2, 2));
  await markerPixel(2, spriteColor(6, 6));
  await markerPixel(3, spriteColor(0, 4));
  await markerPixel(3, spriteColor(0, 4), true);
  await game.eval("$gameMap.events()[0]._direction = 8");
  await pause();
  await markerPixel(1, spriteColor(2, 8));
  assert(
    await game.eval(() => {
      const w = window as any;
      const canvas = document
        .querySelector("#rpgtl-map-view")!
        .shadowRoot!.querySelector<HTMLCanvasElement>("#map")!;
      const [left, top, width] = w.mapGridDraw,
        tile = width / 40;
      return (
        JSON.stringify([
          ...canvas
            .getContext("2d")!
            .getImageData(Math.floor(left + 5.5 * tile), Math.floor(top + 2.25 * tile), 1, 1).data,
        ]) === JSON.stringify([255, 182, 72, 255])
      );
    }),
    "missing Actor1 keeps the filled trigger marker",
  );
  await click('#events button[data-id="1"]');
  await game.waitUntil(`${root}.querySelectorAll('.sprite-picture').length === 3`);
  assert(
    await game.eval(() => {
      const pictures = [
        ...document
          .querySelector("#rpgtl-map-view")!
          .shadowRoot!.querySelectorAll<HTMLCanvasElement>(".sprite-picture"),
      ];
      return pictures.every(
        (picture, index) =>
          JSON.stringify([...picture.getContext("2d")!.getImageData(1, 1, 1, 1).data]) ===
          JSON.stringify(
            [
              [90, 40, 180, 255],
              [215, 150, 180, 255],
              [40, 205, 180, 255],
            ][index],
          ),
      );
    }),
    "every page picture uses its own sheet, index and direction while live marker faces up",
  );
  await game.shot("sprites-default");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await game.waitUntil("mapGridDraw[2] / 40 < 20");
  const spriteMapBox = await game.eval(() => {
    const canvas = document.querySelector("#rpgtl-map-view")!.shadowRoot!.querySelector("#map")!;
    const bounds = canvas.getBoundingClientRect();
    const [left, top, width] = (window as any).mapGridDraw;
    return { x: bounds.x + left + (5 * width) / 40, y: bounds.y + top + (2.5 * width) / 40 };
  });
  await game.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...spriteMapBox,
    deltaX: 0,
    deltaY: await game.eval("-Math.log(20.1 / (mapGridDraw[2] / 40)) * 1000"),
  });
  await pause();
  await game.waitUntil("mapGridDraw[2] / 40 >= 20");
  assert(await game.eval("mapGridDraw[2] / 40 >= 20"), "narrow sprite proof zoom shows ID labels");
  const pan = await game.eval(() => {
    const box = document
      .querySelector("#rpgtl-map-view")!
      .shadowRoot!.querySelector("#map")!
      .getBoundingClientRect();
    const [left, top, width] = (window as any).mapGridDraw;
    return {
      start: { x: box.x + left + (5 * width) / 40, y: box.y + top + (3 * width) / 40 },
      end: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    };
  });
  await game.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...pan.start,
    button: "left",
    clickCount: 1,
  });
  await game.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...pan.end,
    button: "left",
    buttons: 1,
  });
  await game.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...pan.end,
    button: "left",
    clickCount: 1,
  });
  await game.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 550, y: 50 });
  await game.eval(() => new Promise((resolve) => setTimeout(resolve, 150)));
  const narrowShot = await game.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(
    run.evidence + "/sprites-narrow-zoom.png",
    Buffer.from(narrowShot.data, "base64"),
  );
  log("screenshot sprites-narrow-zoom.png");
  assert(
    await game.eval("mapGridDraw[2] / 40 >= 20"),
    "narrow screenshot retains the zoomed sprite map",
  );
  await game.eval(`${root}.querySelector('.sprite-picture').scrollIntoView({block:'center'})`);
  await game.shot("sprites-detail-narrow");
  await game.eval(`${root}.querySelector('header').scrollIntoView({block:'start'})`);
  await game.eval("$gameMap.events()[0]._direction = 2");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 816,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await game.shot("map-open");
  assert(
    await game.eval(() => {
      const w = window as any;
      const canvas = document.querySelector("#rpgtl-map-view")!.shadowRoot!.querySelector("#map")!;
      const [x, y, width, height] = w.mapGridDraw;
      const rect = canvas.getBoundingClientRect();
      const contentWidth = width * (12 / 40);
      const contentHeight = height * (9 / 24);
      return (
        contentWidth >= rect.width * 0.7 &&
        contentHeight >= rect.height * 0.7 &&
        x >= -2 &&
        y >= -2 &&
        x + contentWidth <= rect.width + 2 &&
        y + contentHeight <= rect.height + 2 &&
        width > rect.width * 2 &&
        height > rect.height * 1.5
      );
    }),
    "the enlarged first map fits its rooms and margin while the empty border extends beyond the canvas",
  );
  assert(
    await game.eval(() => {
      const viewRoot = document.querySelector("#rpgtl-map-view")!.shadowRoot!;
      const bar = viewRoot.querySelector(".tile-action")!.getBoundingClientRect();
      return (
        bar.width > 0 &&
        bar.height > 0 &&
        viewRoot.querySelector("#tile-selection")!.textContent === "Click a tile or an event"
      );
    }),
    "the default tile action bar is visible and readable",
  );
  await clickTile(0, 0, 40, 24);
  assert(
    (await read("#tile-selection")).includes("Tile 0, 0 · void"),
    "void tile selection names void",
  );
  await clickTile(1, 1, 40, 24);
  assert(
    (await read("#tile-selection")).includes("Tile 1, 1 · wall"),
    "room border selection names wall",
  );
  await clickTile(3, 3, 40, 24);
  assert(
    (await read("#tile-selection")).includes("Tile 3, 3 · floor"),
    "room interior selection names floor",
  );
  await clickTile(4, 4, 40, 24);
  assert(
    (await read("#tile-selection")).includes("Tile 4, 4 · floor, blocked: up"),
    "player map fence selection names its blocked side",
  );
  await clickTile(4, 1, 40, 24);
  assert(
    (await read("#detail")).includes("Event 3:"),
    "clicking a tall sprite's head in the tile above selects its event",
  );
  await clickTile(3, 3, 40, 24);
  await game.shot("walls-player-default");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  const playerMapBox = await game.eval(() => {
    const rect = document
      .querySelector("#rpgtl-map-view")!
      .shadowRoot!.querySelector<HTMLCanvasElement>("#map")!
      .getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await game.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...playerMapBox,
    deltaX: 0,
    deltaY: -100,
  });
  await pause();
  assert(
    await game.eval("mapGridDraw[2] / 40 >= 8"),
    "narrow player map zoom reveals blocked-side lines",
  );
  await clickTile(4, 4, 40, 24);
  assert(
    (await read("#tile-selection")).includes("Tile 4, 4 · floor, blocked: up"),
    "player map fence selection remains readable at narrow width",
  );
  await clickTile(3, 3, 40, 24);
  await game.shot("walls-player-narrow");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 816,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await clickTile(3, 3, 40, 24);
  assert(
    (await game.eval(`${root}.querySelectorAll('#events button').length`)) === 7,
    "all seven fixture events are listed",
  );
  assert(
    (await game.eval(() => {
      const viewRoot = document.querySelector("#rpgtl-map-view")!.shadowRoot!;
      const list = viewRoot.querySelector("#events")!.getBoundingClientRect();
      return [...viewRoot.querySelectorAll<HTMLButtonElement>("#events button")].filter(
        (button) => {
          const row = button.getBoundingClientRect();
          return row.top >= list.top && row.bottom <= list.bottom;
        },
      ).length;
    })) >= 4,
    "the default event list shows at least four rows at 816×624",
  );
  await click("#filter");
  assert(
    (await game.eval(`${root}.querySelectorAll('#events button').length`)) === 5,
    "filter keeps five active events",
  );
  await click('#events button[data-id="1"]');
  const detailText = await read("#detail");
  assert(
    detailText.includes("Guide: Race: Human!\nHero has 50Gold \\Custom[3]") &&
      !detailText.includes("\\C[2]") &&
      detailText.includes("Conditional Branch"),
    "detail renders cleaned text and nested commands",
  );
  assert(
    (await read('#events button[data-id="1"]')).includes("Guest"),
    "the event list shows its translated name",
  );
  assert(
    (await read(".event-header strong")).includes("Event 1: Guest (客人1号)"),
    "event detail shows translated and original names",
  );
  assert(
    (await read(".conditions")).includes('Switch 1 "Door is open"'),
    "page conditions use the translated switch name",
  );
  assert(
    (await read("#detail")).includes('Switch 1 "Door is open"') &&
      (await read("#detail")).includes("Quest progress = 3"),
    "decoded commands and script values use translated names",
  );
  assert(
    await game.eval(
      '$dataMap.events[1].name === "客人1号" && $dataSystem.switches[1] === "门开了"',
    ),
    "game data keeps the original names",
  );
  await game.shot("names-map-default");
  await game.eval(`${root}.querySelector('.conditions').scrollIntoView({block:'center'})`);
  await game.shot("names-conditions");
  const markerPoint = await game.eval(() => {
    const w = window as any;
    const canvas = document.querySelector("#rpgtl-map-view")!.shadowRoot!.querySelector("#map")!;
    const rect = canvas.getBoundingClientRect();
    const [left, top, width, height] = w.mapGridDraw;
    return { x: rect.x + left + (2.5 * width) / 40, y: rect.y + top + (2.5 * height) / 24 };
  });
  await game.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...markerPoint });
  await pause();
  assert(
    (await read("#tooltip")).includes("Guest (客人1号)"),
    "marker tooltip shows translated and original names",
  );
  await game.shot("names-tooltip");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await game.shot("names-map-narrow");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 816,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  assert(
    await game.eval(() => {
      const viewRoot = document.querySelector("#rpgtl-map-view")!.shadowRoot!;
      const block = viewRoot.querySelector<HTMLElement>(".script-code")!;
      const code = block.querySelector("code")!;
      const style = getComputedStyle(block);
      return (
        code.textContent?.includes('$gameVariables.value(104) ‹职业 = "Teacher"›;\n') &&
        code.textContent.includes("$gameVariables.setValue(117, 0) ‹Target = 0›;") &&
        code.textContent.includes("\n") &&
        style.fontFamily.includes("monospace") &&
        style.whiteSpace === "pre-wrap" &&
        style.overflowWrap === "anywhere" &&
        block.scrollWidth <= block.clientWidth + 1
      );
    }),
    "script commands render as wrapping monospace blocks with line breaks and live variable notes",
  );
  await game.eval(
    `${root}.savedScriptCode = ${root}.querySelector('.script-code code'); $gameVariables.setValue(104, "Student");`,
  );
  await pause();
  assert(
    await game.eval(
      `${root}.savedScriptCode === ${root}.querySelector('.script-code code') && ${root}.savedScriptCode.textContent.includes('‹职业 = "Student"›') && !${root}.savedScriptCode.textContent.includes('"Teacher"')`,
    ),
    "script value notes update in place as game variables change",
  );
  await game.eval('$gameVariables.setValue(104, "Teacher")');
  await pause();
  await game.eval(`${root}.querySelector('.script-code').scrollIntoView({block:'center'});`);
  await game.shot("script-code-block");
  await click(".common-event > summary");
  assert(
    (await read(".common-event-content")).includes("From the common event.") &&
      (await read(".common-event-content")).includes("already expanded above"),
    "self-calling common event expands once",
  );
  assert(
    (await game.eval(
      `${root}.querySelector('.common-event-content').querySelectorAll('.common-event').length`,
    )) === 0,
    "recursive call has no further expansion control",
  );
  await game.eval(`${root}.querySelector('.common-event-content').scrollIntoView({block:'end'});`);
  await game.shot("commands-and-common-event");
  await game.eval(
    `${root}.querySelector('.event-header input').focus(); window.savedRaw=${root}.querySelector('.event-header input'); window.savedRow=${root}.querySelector('#events button[data-id="1"]'); window.savedSummary=${root}.querySelector('.common-event > summary'); $gameMap.events()[0].x=4; $gameVariables.setValue(1,3);`,
  );
  await pause();
  assert(
    await game.eval(
      `savedRaw === ${root}.querySelector('.event-header input') && savedRow === ${root}.querySelector('#events button[data-id="1"]') && savedSummary === ${root}.querySelector('.common-event > summary') && ${root}.activeElement === savedRaw`,
    ),
    "movement and live values preserve controls and focus",
  );
  assert(
    (await read(".event-header small")).includes("(4, 2)") &&
      (await read("#detail")).includes("now 3"),
    "position and command values update in place",
  );
  assert((await read(".conditions")).includes("now 3"), "condition values update in place");
  await click(".event-header input");
  assert(
    await game.eval(
      `${root}.querySelectorAll('.raw-code').length > 0 && [...${root}.querySelectorAll('.raw-code')].some(row => row.textContent.includes('$gameVariables.value(104)') && !row.textContent.includes('‹职业'))`,
    ),
    "raw-code toggle preserves the script as written without value notes",
  );
  await click(".self-switches input");
  assert(
    await game.eval(
      '$gameSelfSwitches.value([1,1,"A"]) && $gameMap.refreshRequested && $gameMap.events()[0]._pageIndex === 2',
    ),
    "self switch refreshes the live event",
  );
  assert(
    await game.eval(`${root}.querySelectorAll('.page')[2].textContent.includes('Applies now')`),
    "detail updates the applicable page",
  );
  await game.press("F7");
  assert(!(await visible()), "F7 closes the view");
  assert(
    await game.eval(
      "Input.clearCalls >= 2 && TouchInput.clearCalls >= 2 && !Object.values(heldGameKeys).some(Boolean)",
    ),
    "closing clears both input states",
  );
  await game.press("F8");
  const panel =
    '[...document.querySelectorAll("div")].find(d=>d.shadowRoot?.querySelector("#mapView")).shadowRoot';
  assert(await game.eval(`!${panel}.querySelector('section').hidden`), "F8 opens controls");
  assert(
    await game.eval(
      `${panel}.querySelector('#switch option[value="1"]').textContent === '1: Door is open' && ${panel}.querySelector('#switch option[value="1"]').title === '门开了'`,
    ),
    "F8 switch list shows the translation and original on hover",
  );
  assert(
    await game.eval(
      `${panel}.querySelector('#variable option[value="1"]').textContent === '1: Quest progress' && ${panel}.querySelector('#variable option[value="1"]').title === '任务进度'`,
    ),
    "F8 variable list shows the translation and original on hover",
  );
  await game.shot("f8-controls");
  await game.eval(
    `${panel}.querySelector('section').scrollTop = ${panel}.querySelector('section').scrollHeight`,
  );
  await game.shot("f8-name-lists");
  await click("#mapView", panel);
  assert(
    (await visible()) && (await game.eval(`${panel}.querySelector('section').hidden`)),
    "F8 Map view button opens view and hides panel",
  );
  await game.press("F8");
  assert(
    !(await visible()) && (await game.eval(`${panel}.querySelector('section').hidden`)),
    "F8 closes map first",
  );
  await game.press("F7");
  await game.eval("$gameMap.events()[0].x=2");
  await clickTile(3, 3, 40, 24);
  assert(
    (await read("#tile-selection")).includes("Tile 3, 3 · floor") &&
      !(await game.eval(`${root}.querySelector('#teleport-tile').disabled`)),
    "a free tile is selected with Teleport here enabled",
  );
  await click("#teleport-tile");
  assert(
    await game.eval("$gamePlayer.locateCalls.some(p=>p[0]===3&&p[1]===3)"),
    "Teleport here uses locate on the current map",
  );
  await clickTile(9, 3, 40, 24);
  assert((await read("#tile-selection")).includes("Tile 9, 3 · wall"), "a wall tile is selected");
  await click("#teleport-tile");
  assert(
    await game.eval("$gamePlayer.locateCalls.some(p=>p[0]===8&&p[1]===3)"),
    "a wall tile teleports to the nearest floor",
  );
  await click('#events button[data-id="1"]');
  assert(
    await game.eval(
      `${root}.querySelector('#teleport-event')?.textContent === 'Teleport next to it'`,
    ),
    "a selected event offers nearby teleport",
  );
  await click("#teleport-event");
  assert(
    await game.eval("$gamePlayer.locateCalls.some(p=>p[0]===2&&p[1]===3)"),
    "Teleport next to it uses the nearest floor beside a blocking event",
  );
  await game.eval("$gameMap.eventRunning = true");
  const calls = await game.eval("$gamePlayer.locateCalls.length");
  await click("#teleport-event");
  assert(
    (await game.eval("$gamePlayer.locateCalls.length")) === calls &&
      (await read("#map-status")).includes("event is running"),
    "event teleport refuses while an event runs",
  );
  await game.eval("$gameMap.eventRunning = false");
  await click("#filter");
  await game.eval(
    `${root}.querySelector('#map-picker').value='2'; ${root}.querySelector('#map-picker').dispatchEvent(new Event('change'));`,
  );
  await game.waitUntil(
    `${root}.querySelector('#title').textContent.includes('Map 2') && ${root}.querySelectorAll('#events button').length === 3`,
  );
  assert(
    await game.eval(
      `${root}.querySelector('option[value="2"]').textContent.startsWith('\u00a0\u00a0')`,
    ),
    "map tree indentation uses nonbreaking spaces",
  );
  await game.shot("map-2");
  await clickTile(0, 0, 8, 7);
  assert(
    (await read("#tile-selection")).includes("Tile 0, 0 · void"),
    "Map 2 tile selection names void",
  );
  await clickTile(4, 1, 8, 7);
  assert(
    (await read("#tile-selection")).includes("Tile 4, 1 · wall"),
    "Map 2 border selection names wall",
  );
  await clickTile(2, 3, 8, 7);
  assert(
    (await read("#tile-selection")).includes("Tile 2, 3 · floor"),
    "Map 2 interior selection names floor",
  );
  await clickTile(3, 3, 8, 7);
  assert(
    (await read("#tile-selection")).includes(
      'Map 2 "Second Field" · Tile 3, 3 · floor, blocked: up',
    ),
    "Map 2 fence selection names its blocked side",
  );
  await clickTile(2, 3, 8, 7);
  await game.shot("walls-map-2-default");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await game.shot("walls-map-2-narrow");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 816,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  await clickTile(2, 2, 8, 7);
  assert(
    (await read("#tile-selection")).includes('Map 2 "Second Field" · Tile 2, 2 · floor'),
    "the selected tile names its other map",
  );
  await click("#teleport-tile");
  assert(
    await game.eval('$gamePlayer.reserveTransferCalls.some(p=>JSON.stringify(p)==="[2,2,2,2,2]")'),
    "Teleport here on map 2 reserves transfer without fade",
  );
  // A plugin ends the transfer on the player's own map instead; later the player reaches map 2.
  await game.eval('$gamePlayer["_transferring"] = false');
  await pause();
  assert(
    await game.eval(`${root}.querySelector('#map-status').hidden`),
    "a teleport a plugin sent elsewhere drops its status",
  );
  await game.eval(() => {
    const w = window as any;
    w.redirectProofMapId = w.$gameMap.mapId;
    w.$gameMap.mapId = () => 2;
  });
  await pause();
  assert(
    !(await read("#map-status")).includes("Moved to") &&
      (await read("#title")).includes("Second Field"),
    "a later arrival on map 2 is not taken for the redirected teleport",
  );
  await game.eval(() => {
    const w = window as any;
    w.$gameMap.mapId = w.redirectProofMapId;
  });
  await pause();
  await click("#back");
  await game.eval('$gamePlayer["_transferring"] = false');
  await game.eval(() => {
    const w = window as any;
    w.saveProofOriginalMap = { gameMap: w.$gameMap, dataMap: w.$dataMap };
  });
  await click('#events button[data-id="1"]');
  await click("#teleport-event");
  assert(
    (await read("#map-status")).includes("Moved to"),
    "event teleport sets a status before loading a save",
  );
  const installSaveMap = async (mapId: number) => {
    await game.eval((mapIdValue: number) => {
      const w = window as any;
      w.DataManager.loadMapData(mapIdValue);
      const width = 30;
      const height = 18;
      const data = Array.from({ length: 6 * width * height }, (_, index) => {
        const layerSize = width * height;
        const x = index % width;
        const y = Math.floor(index / width) % height;
        return index < layerSize && x >= 18 && x <= 24 && y >= 8 && y <= 12 ? 1 : 0;
      });
      const template = w.$gameMap.events()[0];
      const event = { ...template, eventId: () => 1, x: 20, y: 10, ["_mapId"]: mapIdValue };
      w.$dataMap = {
        displayName: `Save map ${mapIdValue}`,
        width,
        height,
        tilesetId: 1,
        data,
        events: [null, { ...event.event(), id: 1, x: 20, y: 10 }],
      };
      w.$gameMap = {
        ["_mapId"]: mapIdValue,
        ["_tilesetId"]: 1,
        mapId() {
          return this["_mapId"];
        },
        tilesetId() {
          return this["_tilesetId"];
        },
        width() {
          return w.$dataMap.width;
        },
        height() {
          return w.$dataMap.height;
        },
        isPassable(x: number, y: number) {
          return x > 0 && y > 0 && x < 29 && y < 17;
        },
        events: () => [event],
        vehicles: () => [],
        isEventRunning: () => false,
      };
      w.$gamePlayer.x = 20;
      w.$gamePlayer.y = 10;
      w.$gamePlayer["_transferring"] = false;
    }, mapId);
    await game.waitUntil(
      `${root}.querySelector('#title').textContent.includes('Save map ${mapId}')`,
    );
    await pause();
  };
  const assertSaveReset = async (label: string) => {
    assert(
      await game.eval(
        `${root}.querySelectorAll('#events button[aria-pressed="true"]').length === 0 && ${root}.querySelector('#detail').textContent === '' && ${root}.querySelector('#tile-selection').textContent === 'Click a tile or an event' && ${root}.querySelector('#map-status').hidden`,
      ),
      `${label} clears event selection, detail, tile bar and status`,
    );
    assert(
      await game.eval(() => {
        const w = window as any;
        const canvas = document
          .querySelector("#rpgtl-map-view")!
          .shadowRoot!.querySelector("#map")!;
        const [x, y, width, height] = w.mapGridDraw;
        const r = canvas.getBoundingClientRect();
        const content = {
          left: x + width * (16 / 30),
          top: y + height * (6 / 18),
          width: width * (11 / 30),
          height: height * (9 / 18),
        };
        return (
          content.width >= r.width * 0.65 &&
          content.height >= r.height * 0.65 &&
          content.left >= -2 &&
          content.top >= -2 &&
          content.left + content.width <= r.width + 2 &&
          content.top + content.height <= r.height + 2
        );
      }),
      `${label} refits the replacement map to its content`,
    );
  };
  await installSaveMap(2);
  await assertSaveReset("loading a save on another map");
  await game.shot("save-load-different-map");
  await click('#events button[data-id="1"]');
  assert(
    await game.eval(
      `${root}.querySelector('.common-event') !== null && !${root}.querySelector('.common-event').open`,
    ),
    "a replacement event does not inherit expanded command blocks from the prior map",
  );
  const tilePoint = await game.eval(() => {
    const w = window as any;
    const canvas = document
      .querySelector("#rpgtl-map-view")!
      .shadowRoot!.querySelector<HTMLCanvasElement>("#map")!;
    const r = canvas.getBoundingClientRect();
    const [x, y, width, height] = w.mapGridDraw;
    return { x: r.x + x + (21.5 / 30) * width, y: r.y + y + (11.5 / 18) * height };
  });
  for (const type of ["mousePressed", "mouseReleased"])
    await game.send("Input.dispatchMouseEvent", {
      type,
      ...tilePoint,
      button: "left",
      clickCount: 1,
    });
  await pause();
  await click("#teleport-tile");
  assert(
    (await read("#map-status")).includes("Moved to"),
    "tile teleport sets status before a same-map save load",
  );
  await installSaveMap(2);
  await assertSaveReset("loading a save on the same map");
  await game.shot("save-load-same-map");
  await game.eval(() => {
    const w = window as any;
    w.DataManager.loadMapData(1);
    w.$gameMap = w.saveProofOriginalMap.gameMap;
    w.$dataMap = w.saveProofOriginalMap.dataMap;
    w.$gamePlayer["_transferring"] = false;
  });
  await pause();
  await game.eval(() => {
    const w = window as any;
    w.passabilityCalls = 0;
    const original = w.$gameMap.isPassable;
    w.$gameMap.isPassable = (...args: any[]) => {
      w.passabilityCalls++;
      return original(...args);
    };
    w.lastMapImage = document
      .querySelector("#rpgtl-map-view")!
      .shadowRoot!.querySelector<HTMLCanvasElement>("#map")!
      .toDataURL();
    w.DataManager.loadMapData(2);
  });
  await pause();
  await pause();
  assert((await read("#title")).includes("Map 1"), "null map data keeps the last snapshot");
  await game.eval(async () => {
    (window as any).$dataMap = await (await fetch("data/Map002.json")).json();
  });
  await pause();
  assert(
    (await game.eval(
      `passabilityCalls === 0 && lastMapImage === ${root}.querySelector('#map').toDataURL()`,
    )) && (await read("#title")).includes("Map 1"),
    "incoming map data is not cached under the old map ID",
  );
  await game.eval("setupFixtureMap(2,$dataMap)");
  await game.waitUntil(`${root}.querySelector('#title').textContent.includes('Map 2')`);
  assert(await game.eval("passabilityCalls > 0"), "redraw resumes and recomputes the new map grid");
  await game.shot("transfer-recovered");
  await game.eval("passabilityCalls=0; $gameMap._tilesetId=2");
  await pause();
  assert(await game.eval("passabilityCalls > 0"), "tileset changes recompute the player grid");
  await game.press("Escape");
  await game.eval("passabilityCalls=0");
  await game.press("F7");
  assert(await game.eval("passabilityCalls > 0"), "reopening recomputes the player grid");
  await game.eval(() => {
    const w = window as any;
    const events = w.$gameMap.events;
    let fail = true;
    w.$gameMap.events = () => {
      if (fail) {
        fail = false;
        throw new Error("fixture transient redraw failure");
      }
      return events();
    };
  });
  await pause();
  await click("#events button");
  await game.eval("$gameMap.events()[0].x=4");
  await pause();
  assert(
    (await read(".event-header small")).includes("(4,"),
    "redraw loop survives a thrown frame",
  );
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause();
  assert(
    await game.eval(() => {
      const viewRoot = document.querySelector("#rpgtl-map-view")!.shadowRoot!;
      const bar = viewRoot.querySelector(".tile-action")!.getBoundingClientRect();
      return (
        bar.width > 0 &&
        bar.height > 0 &&
        viewRoot.querySelector("#teleport-tile")!.textContent === "Teleport here"
      );
    }),
    "the tile action bar remains visible and readable at 600px",
  );
  await game.shot("map-narrow-600");
  assert(
    await game.eval(() => {
      let leaked = 0;
      const types = [
        "mousedown",
        "mouseup",
        "mousemove",
        "mouseover",
        "mouseout",
        "mouseenter",
        "mouseleave",
        "click",
        "dblclick",
        "auxclick",
        "contextmenu",
        "pointerdown",
        "pointerup",
        "pointermove",
        "pointerrawupdate",
        "pointerover",
        "pointerout",
        "pointerenter",
        "pointerleave",
        "pointercancel",
        "gotpointercapture",
        "lostpointercapture",
        "touchstart",
        "touchmove",
        "touchend",
        "touchcancel",
        "wheel",
        "mousewheel",
      ];
      for (const type of types) document.addEventListener(type, () => leaked++);
      const host = document.querySelector("#rpgtl-map-view")!;
      const target = document.elementFromPoint(2, 2)!;
      if (target !== host) return false;
      for (const type of types)
        target.dispatchEvent(new Event(type, { bubbles: true, composed: true, cancelable: true }));
      return leaked === 0;
    }),
    "backdrop isolates every mouse, pointer, touch and wheel type",
  );
  await game.press("Escape");
  await game.send("Emulation.setDeviceMetricsOverride", {
    width: 816,
    height: 624,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await game.goto("/game/" + id + "/");
  await game.waitUntil('!!document.querySelector("#rpgtl-map-view")');
  await measureDraw(game, log);
  await game.press("Escape");
  await game.eval("$gameMap._mapId=0");
  await game.press("F7");
  assert(
    (await read("#empty", "hidden")) === false,
    "before starting only the start/load message appears",
  );
  await game.shot("before-start");
};
