# Testing

`pnpm test` runs two projects. `node` has no browser: its tests either serve a fixture game from `packages/game/src/testUtils/fixture.ts` or load an injected script against a fake engine. `web` runs the page's component tests (`apps/web/src/**/*.test.tsx`) in headless Chromium; `pnpm exec vp test --project web` runs them alone.

The llama-server test of the memory limit needs the user systemd bus (`systemd-run --user --scope`) and skips without it, so in a sandbox any failure left is real.

Image reading is tested on the server with a fake image reader and a fake fallback model (`apps/server/src/imageText/`), and its rules in `packages/domain/src/imageReading.test.ts` and `imageText.test.ts`. None of these download anything.

## Page component tests

Each test renders a part of the page against `testUtils/fakeApi.tsx`, which answers the page's requests for the whole file (the HTTP client reads `fetch` once). `router.test.tsx` renders the real routes with a memory history. Traps that cost a rerun each:

- `getByRole(…, { name })` matches the whole accessible name. A button that ends with its count ("Untranslated 27") needs a RegExp (`/^Untranslated/`), and a RegExp that matches two buttons fails, so scope it (`page.getByRole("group", { name: "Show" })`).
- `getByText` matches an element's whole text: text split over child elements needs `{ exact: false }`. Before trusting `toHaveTextContent`, look at the element's whole `textContent` in the failure: hidden parts add text, such as Progress's "x".
- The default viewport is narrow, so a two-column page clips its right column and `toBeVisible` times out with the text in the DOM: call `page.viewport(1280, 800)` in `beforeAll`.
- Base UI's Switch and Checkbox put the `id` on a hidden input, so drive a switch through its label, and find a checkbox with `getByRole("checkbox", { name })`: `getByLabelText` finds both the box and the hidden input.
- `GameHeader` and anything else using the sidebar needs `SidebarProvider`; to check the save status, read the `editsStatus` atom instead, as `text/TextPage.test.tsx` does.
- A fake server that answers with fixed data can't show that the page reads something again: make the answer follow what the page saved, as the Text page test's checks do.

To see how a part of the page looks in a state no real game reaches easily (a setup step, a failed run), render it in a throwaway test with `import "./index.css"` and save `await page.screenshot({ path: "../scratch/<name>.png" })`. The path is relative to the test file and must stay inside `apps/web`, which keeps `scratch/` out of git. Look at each state a change adds: a test that only checks text and `aria-valuenow` passes even when the bar draws nothing.

## Image reader

The Python service's own tests need the real reader. Set it up in **Settings** (or point `XDG_CACHE_HOME` at a scratch folder first, so it lands there), then start it from the repo's sources, which it reads on start, so a change to `lettering.py`, `worker.py` or `server.py` needs only a restart:

```sh
cd apps/image-reader && IMAGE_TEXT_DEVICE=gpu IMAGE_TEXT_MODELS=~/.cache/rpgtl/image-reader/models ~/.cache/rpgtl/image-reader/venv/bin/python -m uvicorn server:app --port 5001
```

Use the device that `setup.json` in that folder names (`gpu`, `directml` or `cpu`). `--reload` restarts it on every change to a `.py` file under `apps/image-reader`, which drops the request in progress, so don't edit files there while a comparison runs against it.

Then run `uv run --project apps/image-reader/tests pytest apps/image-reader/tests`. The tests skip, pointing here, if the reader isn't reachable, and the Korean ones skip without the Korean recognizer (**Add the Korean model** in **Settings**). `test_lettering.py` needs no reader. The erased fixtures are saved in `.verify/image-text/` to look at. To regenerate the committed fixtures, run `uv run --project apps/image-reader/tests python apps/image-reader/tests/make_fixtures.py` on a machine with Noto Sans CJK SC installed.

A scratch script that calls the reader's functions directly goes in the git-ignored `apps/image-reader/local/`. Run it from `apps/image-reader` as `IMAGE_TEXT_MODELS=~/.cache/rpgtl/image-reader/models ~/.cache/rpgtl/image-reader/venv/bin/python -m local.<name>`, so `import server` works. `from compare.games import game_image` gives an image of a game's state folder by its name in `images.json`, decrypted. Set `server.app.state.models = server.Models("gpu", 4)` first and call its `unload()` at the end. The models run in a spawned process, which imports the script again, so its code must sit under `if __name__ == "__main__":`.

### Comparing image readers

`apps/image-reader/compare/` is a uv project for comparing PaddleOCR with a local Ollama vision model (`qwen3.6:35b-a3b-q4_K_M`) and trying English lettering. Its tests run with `uv run --project apps/image-reader/compare pytest apps/image-reader/compare/tests`; the Qwen test needs the model in Ollama, and `tests/test_layout.py` needs neither service.

For real images, use only an approved list of image paths, one per line, kept out of the repo, and never add images to it yourself. Start the reader as above and Ollama, then run:

```sh
uv run --project apps/image-reader/compare python apps/image-reader/compare/compare.py --out .verify/image-text/compare --list <list of images>
```

It writes a report (`index.html`), images and caches under `--out`. `--readers paddle` runs without Ollama and `--readers qwen` without the reader; `--redo paddle|qwen|draw` repeats that phase from the cached results. Requests are serial, and Qwen is unloaded after them; stop the reader you started afterwards.

To see what a change to erasing does to a game's images, start the reader from the changed sources and run:

```sh
uv run --project apps/image-reader/compare python apps/image-reader/compare/compare.py --erase <copy of RPGTL_DIR>/games/<game id> --out .verify/image-text/erase
```

It prepares each image the game's `images.json` has prepared again, with the same lines, and writes only into `--out`. The report shows the images where more than `--min-change` (default 0.05) of the pixels are erased by only one of the two; `sheet.png` puts the 12 most changed in one picture. The inpainter's texture differs between runs, so this counts erased pixels, not colors. `--list <file>` (lines of `<game id> <image name>`), `--only <prefix>` and `--skip <text>` limit the images.

To compare two versions of the reader instead of the saved erases, run the one to compare with from a git ref on a second port and pass `--baseline`:

```sh
apps/image-reader/compare/reader_at.sh main 5002
uv run --project apps/image-reader/compare python apps/image-reader/compare/compare.py --erase <copy of RPGTL_DIR>/games/<game id> --baseline http://127.0.0.1:5002 --out .verify/image-text/erase
```

LaMa gives the same output for the same input, so two readers on the same commit show no change. `--pixels` compares the erases pixel by pixel, which also catches the same pixels filled with other colors, such as ghosts of letters.

Before the full comparison, run a short regression list of approved images (`--list`), a few of each kind an erase change has broken before: round icons, small plates and signs, map pictures with hint bands, faces, HUDs over transparency, panels, bubbles, titles. 28 such images take about a minute on the GPU, where 428 took 12 minutes. A change that passes it still needs the full comparison.

## Runtime tests

`loadRuntime(engine)` in `packages/game/src/testUtils/fixture.ts` runs `packages/game/src/runtime/` against fake MV or MZ window classes where every character is 10px wide. Extend the fake classes there when a hook needs more of the engine. The drawing itself needs a browser: verify-rpgtl's `examples/image-text.ts` checks the bitmap's pixels in the fixture game.

This checks the logic, not the look: fonts, face graphics and plugins only show in the running game. For hooks that meet the engine's own loading order, windows, keys or saving, `packages/game/src/testUtils/mvGame.ts` writes a game on MV's real engine with made-up plugins, which the end-to-end tests and verify-rpgtl's `real-MV` play. MZ has only the stubs.

XP's text fitting and image scripts are Ruby, which only a real engine runs. `apps/server/src/mkxpz/textFitting.test.ts` and `imageText.test.ts` play a made-up XP game in mkxp-z on an Xvfb display (`playXpGame` in `testUtils/mkxpz.ts`): the game's `Main` draws labels and messages or loads images, measures what the engine drew, and writes it to a file the test reads. The test uses the mkxp-z that RPGTL downloads into `~/.cache/rpgtl/mkxpz/<version>/`, and skips when it isn't there or `xvfb-run` is missing, as in CI. Download it once from the Play button of any XP game. To run a game of your own in it, write a `mkxp.json` as `mkxpConfig` in `Mkxpz.ts` does and start `SRCDIR=<folder of mkxp.json> xvfb-run -a ~/.cache/rpgtl/mkxpz/<version>/mkxp-z.x86_64`. Don't start the folder's `AppRun`: it sets `SRCDIR` itself, to a copy of the build's own `mkxp.json`. A Ruby error waits in a message box nobody can close, and mkxp-z keeps running when `xvfb-run` is killed, so the test's game catches every error and writes it to the report; after a hung run of your own, stop `mkxp-z.x86_64` by its PID.

## End-to-end tests

`pnpm run e2e` runs `e2e/*.spec.ts` with Playwright against a real RPGTL server. `e2e/rpgtl.ts` starts one per worker on a temporary state folder, with an Xvfb display for the games it starts in NW.js (so the tests need `Xvfb`), and writes each test's fixture game. NW.js comes from `~/.cache/rpgtl/nwjs/`, downloaded through RPGTL if missing. NW.js has no remote debugging, so `playNwjs.spec.ts` adds a plugin that reports from inside the game.

`pnpm run e2e:archive` builds the Linux download and runs the same tests against it (`RPGTL_E2E_ARCHIVE`). CI runs them this way, which catches what only breaks in the download: an import the bundle leaves out, the prebuilt page, the launcher.

A test that plays MV's real engine presses keys with `key` from `e2e/realMv.ts` (verify-rpgtl's: `examples/real-mv.ts`), never a bare `keyboard.press`, and waits for what the game does, never for a fixed time. The engine reads input once per update and runs several updates in one frame when it falls behind, so on a busy CI runner a bare press is missed or repeated although it passes locally. The end-to-end tests play it at four times its speed, so a state that lasts only a few updates, such as a step next to a wall, can begin and end between two polls: let the game record it, as `holdUntilStep` does. To check that such a test holds up under load, run it with its page slowed down by CDP's `Emulation.setCPUThrottlingRate` at 20 to 40.

## State files

`apps/server/src/state/formats/<n>/` holds made-up files as RPGTL saves them in format `n`: a state folder in `state/` and the settings in `config/`, with each optional field used at least once. `formats.test.ts` upgrades each format to the latest one and decodes the result. A schema change that these files no longer decode with needs a step in `stateUpgrades.ts` (or in `Settings.ts` for the settings) and a folder for the new format. A change they still decode with, such as a new optional field, goes into the newest format's files.

`pnpm run decode-state <dir> [--settings <settings.json>]` decodes `games.json` and each game folder's catalog, backups, image read results, reading, samples, playtime and run logs in a state folder with the schemas the server reads them with, and the settings file when given, and exits with 1 if any file doesn't decode. It only reads. Run it on a copy of a real state folder after changing a schema of a state file: older files can hold values the current types no longer list.

## Game errors

When a player reports a hang or error from a game played in NW.js, read `games/<game id>/logs/nwjs.log` in the state folder first: lines starting with `Game error:` are the game's script errors, unhandled rejections and console errors. Lines starting with `Start:` tell how far the start got: NW.js and system versions, the window's size, place and visibility, the graphics card WebGL runs on, and after 1, 5, 15 and 60 seconds how many frames the page drew and the engine's scene. A window that stays blank while the game plays sound and draws frames is Chromium not showing it; one that draws no frames, or stays `hidden`, is a window Chromium takes for hidden. A hang without any of them is often a loop that waits (scrolling text, an event that never ends), so check what the engine does instead.

## Engine source

To check what a runtime hook sees, read the engine instead of guessing. MV's is in `packages/game/node_modules/rpgmaker-mv-corescript/js/`, one file per class (`rpg_windows/Window_Message.js`), at the version the real-MV fixture game runs. For MZ, and for a game's plugins, read the inspected game's `<webRoot>/js/rmmz_windows.js` and `js/plugins/`. The game's `webRoot` is in `games.json` in the state folder (`.rpgtl/`, or wherever `RPGTL_DIR` points); if neither exists, ask where it is instead of searching the disk.

## Ollama runs

Agents may start Ollama or llama-server models for checks. Comparisons you start keep the context of 4096 that runs use. Stop llama-server or unload Ollama models as soon as the check is done, and say in the report what was loaded.

Speed was tested with Qwen3.6 on llama-server with 32 expert layers in system RAM, which the page runs with 4 slots and 4 event lists at once; timing comparisons use `pnpm run compare --model '<model>@experts=32'`, which runs it the same way. Plain Ollama put only about 6% of that model on the 8 GB GPU of that test and ran several times slower.

A compare report's JSON keeps each setup's run as the lines its run log would hold (`packages/contracts/src/runLog.ts`). A request is a retry when any of its `entryIds` appeared in an earlier request of that run.

Use `pnpm run llama-server --model <ollama model> --experts <n>` for manual llama-server checks, so the same memory estimate and settings as real runs apply.

## Checks and hooks

Committing formats and lints the staged files and runs Knip (`staged` in `vite.config.ts`, about a second). The pre-push hook runs the checks without formatting on each commit pushed, so a push right after `pnpm run checks` costs nothing. A pushed commit whose files differ from the checkout's is checked in a worktree the hook keeps at `.git/rpgtl-checked`. To check each commit of a branch on its own, run `git rebase -x 'pnpm run checks' <base>`, which skips commits whose files already passed.
