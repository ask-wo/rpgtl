# Play in browser

**Play in browser** in a game's header opens the game at `/game/<id>/` in a new tab: RPGTL serves the game's files, injects `runtime.js` (text wrapping and the F8 panel) into `index.html`, and, while the game's translation switch is on, swaps translations into `data/*.json` and `js/plugins.js` as they load. With it off it serves the game's own files. **Play** next to it starts the game in a downloaded NW.js instead.

## Sub-features

- `play-link` **Play in browser** points at `/game/<id>/` and opens a new tab.
- `play-data` saved translations are served in `data/*.json` and plugin parameters in `js/plugins.js`.
- `play-runtime` `index.html` gets `<script src="/runtime.js" data-game="<id>">`.
- `play-f8` F8 opens the game controls panel.
- `play-map` F7 or the F8 panel’s **Map view** button opens the current map overlay.
- `play-engine` the game runs on MV's real engine with the runtime injected: plugins load, translations show in real windows, and saving and loading work.
- `play-nwjs` **Play**, the NW.js download it asks for, **Stop** in its place while the game runs, and the last start's status under it.

## How to get to it (user POV)

- **Play in browser** in an opened game's header.
- **Play** in the same header, for NW.js.
- F8 inside the game tab.

## Driving it with drive.ts

Preconditions:

- Fixture game open (the first lines of `examples/open-game.ts`). For translated data, the translation switch on and English typed on the Text page (see `edit-translations.md`). Only the fixture game; never a real one.

- **Link.** `await page.eval(() => [...document.querySelectorAll("a")].find((a) => a.textContent.startsWith("Play in browser")).href)` ends with `/game/<id>/`.
- **Game tab.** `const game = await openPage("/game/" + id + "/")`. `game.text("h1")` is `Fixture Adventure`; `game.eval(() => !!document.querySelector('script[data-game]'))` is `true`.
- **Translated data.** `game.eval(async () => (await fetch("data/CommonEvents.json")).text())` contains the saved English and not the source.
- **F8 panel.** `game.press("F8")`. The panel lives in a shadow root: `game.eval(() => [...document.querySelectorAll("div")].some((d) => d.shadowRoot?.textContent?.includes("RPGTL game controls") && !d.shadowRoot.querySelector("section").hidden))` is `true`. Its buttons (`#setGold`, `#heal`, …) are inside that shadow root, so drive them with `game.eval`; the fixture's stub engine only records the calls.
- **Real engine.** `e2e/playRealMv.spec.ts` (`pnpm run e2e`) checks playing the real-MV game through: translations edited on the Text page in the title command a plugin adds and in the message window two plugins resize, a choice, scrolling text, and a save made through the menu loaded from the title screen. To show a change on it, start from `verify.sh <name> real-MV .agents/skills/verify-rpgtl/examples/real-mv.ts`, which starts a new game and shows the intro. Its exported helpers (`newGame`, `closeMessage`, `walk`, `choose`, `confirm`) drive the real game from other steps files. MZ has no real engine here (its licence forbids handing it out), so MZ stays on the stubbed fixture.
- **Map view.** Run `node .agents/skills/verify-rpgtl/scripts/drive.ts "$RUN" .agents/skills/verify-rpgtl/examples/map-view.ts` for both MV and MZ fixtures. The proof translates the fixture's event, switch and variable names through the editor, checks the event list, detail, tooltip, page conditions, decoded commands and F8 lists, and confirms the game data still has its original names. It also covers F7 and the F8 button, a held key released across opening, event filtering, recursive common-event expansion, stable controls and focus during live updates, tile and event teleport actions with refusal during events, map 2, self switches, null/incoming map data and recovery, cache refresh on tileset change and reopening, full-window input isolation, and 816×624 / 600 px screenshots. It logs the average redraw time over two seconds on a 200×200 map with 300 events. The timing wraps only the view's `tick` callback and excludes warm-up. That proof runs on the stubbed engine. On MV's real engine, `e2e/mapViewRealMv.spec.ts` checks what only the engine shows: the view stays above the canvas after MV's `Graphics` set up the page, a movement key released while the view is open doesn't stay held, tile and event teleports move the player and refuse during an event, a teleport to map 2 transfers while `$dataMap` is null, and after a save is loaded from the title screen the view shows the loaded `$gameMap`. `examples/map-view-real.ts` opens the view on the real engine as a starting point.
- **Proof.** `game.shot("game-tab")` and the fetched data file saved into evidence.

## Gotchas

- The fixture's engine is a stub: nothing renders on a canvas, so screenshots of the game tab show the plain `index.html`. Rendering, fonts and wrapping in real windows need a check in a real game; list it in your report.
- **Play** asks to download 196 MB to the shared `~/.cache/rpgtl/nwjs/` when NW.js isn't there, and opens a desktop window. Don't trigger it unless the change is about NW.js and you were told to; `pnpm test` covers the download, the start and their status (`apps/web/src/nwjs/PlayButtons.test.tsx` for the page's side). To press it in a run without a window on the desktop, launch with an Xvfb display and NW.js kept off Wayland: `env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 DISPLAY=:<n> $S/scripts/launch.sh …`, as `e2e/rpgtl.ts` does.
- Translations load with the data, so a game tab opened before a save needs a reload.
