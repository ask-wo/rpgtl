---
name: verify-rpgtl
description: Launch an isolated RPGTL (the local RPG Maker MV/MZ translator web app) on a fixture game, drive its page in headless Chrome, and keep screenshots and logs as proof. Use when a change to apps/server/src/, apps/web/src/ or packages/game/src/ must be shown working in the real app, not only in pnpm test.
---

# Verify RPGTL

RPGTL's surface is a web page served by `node apps/server/src/main.ts` on `127.0.0.1`. The page opens a game folder, edits and machine-translates its text, and serves the game to a browser tab with translations applied. Secondary surfaces are CLIs (`pnpm run audit`, `compare`) that read the state folder; they report translation quality and are not a way to drive the app.

Rules from `AGENTS.md` that bind this skill:

- Never drive a real game (any game not written for the test) in a browser. Drive only the fixture game that `launch.sh` writes. Checks in a real game go into your report as open items.
- Opening the RPGTL page itself in a browser is fine.
- Ollama runs you start keep the default context of 4096.

All helpers live in `.agents/skills/verify-rpgtl/scripts/`. Paths below are relative to the repo root; `S=.agents/skills/verify-rpgtl`.

## One command

```sh
$S/scripts/verify.sh <name> <MV|MZ|real-MV> <steps.ts>
```

Launches a run, checks it with the doctor, drives the steps file, cleans up and prints the evidence folder, exiting non-zero when the steps fail. A run takes a second or two, so use it for every attempt: fix the steps or the code and run it again under a new name. Keep the steps file outside the run folder (`.verify/<name>-steps.ts`, or `examples/` when it's worth keeping), since the run folder is created fresh. Copy files you need from `run.state` into `run.evidence` inside the steps, because cleanup deletes `state/`. Remove the attempts with `cleanup.sh --prefix <name>` when done. The sections below are for keeping a server up between drives, for example to look at it by hand.

## Launch

```sh
S=.agents/skills/verify-rpgtl
RUN=$($S/scripts/launch.sh <name> [MV|MZ|real-MV])   # prints /…/rpgtl/.verify/<name>
```

It writes a fixture game to `/tmp/rpgtl-verify-<random>/game`, a path that names no user since the page shows it, and links `$RUN/game/` to it; `run.game` in a steps file is the real path. `MV` and `MZ` write the game from `packages/game/src/testUtils/fixture.ts` plus two Chinese dialogue lines, on a stubbed engine that only has what the runtime touches. `real-MV` writes the game from `packages/game/src/testUtils/mvGame.ts`: MV's real engine ([rpgtkoolmv/corescript](https://github.com/rpgtkoolmv/corescript), MIT, a dev dependency pinned to one commit) with made-up data, blank images and three made-up plugins (`FixtureCore` changes the screen to 960×540, the font to 22 and lines to 30px like YEP_CoreEngine; `FixtureMessage` shows three message rows and adds `\AN[n]`; `Credits` adds a title command named by a Chinese plugin parameter). Use `real-MV` when a change meets the engine's own order of loading, windows, keys or saving; `examples/real-mv.ts` shows how to start it, and `e2e/` (`pnpm run e2e`) holds the checks that play it through. Nothing in it comes from a real game, so it's fine to drive. The server starts with:

- `RPGTL_DIR=$RUN/state` (games list, catalogs, backups, logs)
- `XDG_CONFIG_HOME=$RUN/config` (translator settings; without it the run would overwrite the real `~/.config/rpgtl/settings.json`)
- `XDG_STATE_HOME=$RUN/state-home` (Claude's sessions and RPGTL's Codex login), or the folder `RPGTL_VERIFY_STATE_HOME` names; see `features/machine-translation.md` for a Codex run
- `PORT=0`, so the OS picks a free port

It is ready when `$RUN/server.log` shows `RPGTL is ready: http://127.0.0.1:<port>/`; `launch.sh` waits for that line, writes the address to `$RUN/url` and exits non-zero with the log if the server dies first. Set `RPGTL_DEV=1` before `launch.sh` to serve the page through Vite's dev server and rebuild the game scripts (`packages/game/src/`) on each request; `apps/server/src/` changes always need a new run.

Each run has its own port, state, config and Chrome profile, so several runs can coexist. Shared between runs and with everything else on the machine: the Ollama server and GPU (`ollama ps` before a translation run; don't start one while another run is going), and the NW.js download cache `~/.cache/rpgtl/nwjs/`.

## Doctor

```sh
$S/scripts/doctor.sh "$RUN"
```

Read-only. Checks the server pid is alive and runs `apps/server/src/main.ts`, holds the port in `$RUN/url`, uses `$RUN/state` and `$RUN/config` (so it can't touch the machine's real RPGTL data), serves a token and answers the API, and that neither HEAD, `apps/server/src/` nor `packages/game/src/` changed since launch. Run it first whenever anything looks off; any `FAIL` means clean up and launch again rather than drive.

## Drive

```sh
node $S/scripts/drive.ts "$RUN" <steps.ts>
```

`drive.ts` starts headless Chrome (Playwright's cached `chrome-headless-shell`, or `RPGTL_VERIFY_CHROME`) with its profile in `$RUN/browser`, opens the RPGTL page, runs your steps file and stops Chrome. It exits 1 if the steps throw. A steps file default-exports one function:

```ts
export default async ({ page, openPage, api, run, log }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  await page.shot("opened");
};
```

- In a real-MV game, the engine reads input once per update, and runs several updates in one frame when it falls behind, so a bare `page.press` can be missed or read twice. Press keys with `key` from `examples/real-mv.ts`, which makes the game read each press exactly once and waits until it has; its other helpers also wait for windows to take input. `page.press(key, modifiers, holdMs)` holds a key down for `holdMs`, for walking or holding OK.
- `page.goto(path)`, `page.click(selector)` (real mouse events at the element's centre, after waiting for it to be visible and enabled: the page disables every control while a task runs and ignores clicks then), `page.clickText("Clear mismatches", ".glossary-row")` (button or link by exact text, or by a RegExp such as `/^Untranslated/` for one that ends with a count), `page.labelled("English for Recover \\V[1] HP.", "textarea")` (a selector by `aria-label`, with quotes and backslashes escaped), `page.fill(selector, text)` (selects, then types), `page.select("#runner", "Ollama")` (opens a select by its trigger and clicks the option with that exact text), `page.press("s", ["Control"])`, `page.text(selector)`, `page.eval(fn | expression, ...args)`, `page.waitFor(selector, ms)` (visible match), `page.waitUntil(expression, ms)` (truthy JS), `page.shot(name, selector?)` (the whole page, or only the first element the selector matches, such as `[data-sidebar="sidebar"]`), `page.send(method, params)` for raw DevTools calls.
- `confirm()` dialogs (Clear all translations, Remove all, NW.js download) are accepted automatically and logged; `page.dialogs` lists them.
- `openPage(path)` opens a second tab, e.g. the game at `/game/<id>/`.
- `api(route, body?)` calls the page's token-checked API (`api("games")`, `api("catalog?id=<id>")`, `api("translate?id=<id>")`). Use it to read state after a UI action, not to perform the action.
- `run` has `dir`, `url`, `state`, `game`, `evidence`; `log(line)` adds to the actions log.

The page (`apps/web`) has the open page, a game's overview with Play, the missing images' warning and the Translation card, the run bar with **Translate** (**Build glossary** on the Glossary page, **Read new images** on the Images page) and **Stop** under the game's header (`[aria-label="Runs"]`), the Glossary page (`a[href$="/glossary"]` in the sidebar), the Text page (`a[href$="/text"]`), the Images page (`a[href$="/images"]`), and Settings. Handles: `#game-path` (the path field on `/`; **Open** and **Choose folder…** by text; **Open a game…** in the sidebar and **Choose folder…** open the page's folder browser (`examples/folder-browser.ts`)), the game's title in `h1`, sidebar games as `[data-game-root="<game folder>"]` with `[aria-label="Remove <title> from the list"]`, and in Settings the switches `#sharpPixels` and `#sharpText` (hidden inputs: click `label[for="sharpPixels"]`, read `.checked`). The game id is the page path after opening: `location.pathname.slice("/games/".length)`. Screenshots show the page in dark mode. `map-view.ts` drives the game's map view.

`examples/open-game.ts` is a complete, passing steps file: open the fixture by path, from the sidebar and by its address, change a setting and remove the game from the list. Copy it as a starting point. Put your own steps files in `$RUN/` so they go away with the run, or in `examples/` when they are worth keeping.

The feature map in `features/` lists every user-facing feature with how to reach it and what proves it works. Read the file for the feature you are verifying before writing steps; a proof that drives one entry point is incomplete when the map lists others.

## Evidence

Everything lands in `$RUN/evidence/` (`.verify/` is git-ignored):

- `NN-<name>.png`: full-page screenshots from `page.shot`
- `actions.log`: every goto, click, fill, key, dialog and `log()` line with timestamps, and `steps passed` / `steps FAILED` with the stack
- `console.log`: the page's console output and uncaught exceptions
- `server.log`: moved here by cleanup

Proof standards:

- Drive the path a user takes: paste a path and press Open, type in the box and wait for its save. Don't call `api("entries", …)` or set `entry.translation` to stand in for the UI.
- Capture before and after: a screenshot of the action and of the resulting state, not only the end screen.
- Look at each screenshot as a reviewer would: a mark or column added to a list lines up across rows whose titles differ in length, and nothing is cut off or overlaps.
- Screenshots for a pull request show only made-up paths and names: put copies of the fixture next to `run.game`, not in the run folder, and crop to the part that matters with `page.shot(name, selector)`.
- Check side effects next to what's visible: `$RUN/state/games/<id>/catalog.json` (catalog), `$RUN/state/games/<id>/backups/`, `$RUN/state/games/<id>/logs/translation-<start>.log`, `$RUN/config/rpgtl/settings.json`, and what `/game/<id>/data/*.json` serves. Copy the files you rely on into `$RUN/evidence/` before cleanup, which deletes `state/`.
- Translation runs use the real local Ollama, Claude or Codex. The fake servers in `apps/server/src/testUtils/` are for `pnpm test` only.
- For checks only a real game can answer (fonts, wrapping in real windows, plugins), list what to look at in your report instead of driving it.

## Cleanup

```sh
$S/scripts/cleanup.sh "$RUN"
```

Stops the Chrome and server that this run started (by the pids in `$RUN/browser.pid` and `$RUN/server.pid`, after checking their command lines, never by process name), moves `server.log` into `evidence/`, and deletes `state/`, `state-home/`, `config/`, `game/` and `browser/`. `$RUN/evidence/` and `$RUN/commit` stay. Run it after every attempt, failed ones included. Delete `.verify/<name>/` yourself once the evidence is no longer needed. Throwaway runs, such as ones that only show a check can fail, are removed when the task is done: `$S/scripts/cleanup.sh --prefix <name>` cleans up and deletes every `.verify/<name>*` run.

## Helpers

| Script | Use |
| --- | --- |
| `scripts/verify.sh <name> <MV\|MZ\|real-MV> <steps.ts>` | Launch, doctor, drive and cleanup in one go; prints the evidence folder |
| `scripts/launch.sh [name] [MV\|MZ\|real-MV]` | Writes the fixture game, starts an isolated server, prints the run folder |
| `scripts/doctor.sh <run>` | Read-only health check; non-zero on any failure |
| `scripts/drive.ts <run> <steps.ts>` | Runs a steps file in headless Chrome against the run |
| `scripts/cleanup.sh <run>` | Stops the run's processes, removes scratch state, keeps evidence |
| `scripts/cleanup.sh --prefix <name>` | Does that for every `.verify/<name>*` run, then deletes the run folders |
| `scripts/fixture.ts <dir> [MV\|MZ\|real-MV]` | Writes only the fixture game (launch.sh calls it) |
