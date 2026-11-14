# Open a game

The user points RPGTL at an unpacked MV/MZ game folder; RPGTL scans its text, adds it to the recent games in the sidebar, and shows its overview at its own address `/games/<game id>`. Its sidebar row and its address reopen it without rescanning; opening its folder again rescans it.

## Sub-features

- `open-path` opens a pasted folder, `index.html` or executable path with **Open**.
- `open-library` reopens a game from the sidebar's **Games** without rescanning; a game whose folder is gone shows **Choose its new folder…** under its row.
- `open-address` loads `/games/<game id>` directly, keeping the saved catalog.
- `open-forget` removes a game from the list with its `×` and keeps its translations.
- `open-delete` deletes a game with its `×`: its line in `games.json` and its state folder go, and opening its folder again opens it as a new game.
- `open-pick` chooses a folder in the page's folder browser, which marks folders holding a game.
- `open-version` opening a folder that holds another version of a saved game (same MZ game id, or encryption key and title, or only the title) asks first: **Replace** keeps the saved game's id and the translations of unchanged lines after a backup, **Keep both** opens it as a new game, **Don't open** opens nothing.
- `open-overview` the overview: missing images, missing sounds and NW.js media warnings when there are any, and the in-game tools.

## How to get to it (user POV)

- On the start page `/`, paste a path into "Game folder, Game.exe or index.html" and choose **Open** (or press Enter).
- **Open a game…** at the top of the sidebar, or **Choose folder…** on the start page, and pick a folder in the folder browser: open folders by clicking them, **Up**, **Home**, or type a path and **Go**, then **Choose this folder**.
- Click a game under **Games** in the sidebar.
- Reload or bookmark `http://127.0.0.1:<port>/games/<game id>`.
- Hover a game in the sidebar and click its `×`.

## Driving it with drive.ts

Preconditions:

- Fresh run; `api("games")` returns `[]`.

- **Open by path.** `await page.fill("#game-path", run.game); await page.clickText("Open"); await page.waitUntil('document.querySelector("h1")?.textContent === "Fixture Adventure"')`. `location.pathname` is `/games/<20 hex id>`, and the header shows the engine `MV` and the folder.
- **Another version.** `examples/open-version.ts` copies `run.game` to a folder named `… v2` and opens it: the dialog names the copy's version `(v2)`, **Don't open** opens nothing, **Replace** keeps the address and moves the game to the copy, and opening the first folder again with **Keep both** lists a second game.
- **Index or exe path.** Repeat with `run.game + "/index.html"`. The same game id opens (no second sidebar entry).
- **Library.** `await page.goto("/")`, then `await page.click(\`[data-game-root="${run.game}"]\`)`: the button carries the game's folder. The overview opens with the same id.
- **Own address.** `await page.goto("/games/" + id)`. The overview shows without pressing Open.
- **Forget.** `await page.click('[aria-label="Remove Fixture Adventure from the list"]')` (it shows on hover, but `page.click` reaches it), then `page.clickText("Remove from list")` in the dialog that asks first. The page goes to `/`, `api("games")` is `[]`, and `$RUN/state/games/<id>/catalog.json` still exists.
- **Delete.** The same `×`, then `page.clickText("Delete")`. The page goes to `/`, `api("games")` is `[]`, `$RUN/state/games/<id>/` is gone and `games.json` no longer has the game.
- **Overview.** The fixture asks for `img/characters/Actor1`, which it doesn't ship, so the overview starts with "1 image the game asks for isn't in its folder".
- **Folder browser.** `await page.clickText("Choose folder…")`, fill `input[name="path"]` and `clickText("Go")`, `clickText("Up")`, click the folder whose button text is `gameGame` (its name and the Game badge) in `[aria-label="Folders"]`, then `clickText("Choose this folder")`. `examples/folder-browser.ts` does this. The MV fixture keeps `data/` directly in the game folder, with no `www/`.
- **Proof.** `page.shot("opened")` after each entry point, and the `api("games")` result logged. `examples/open-game.ts` does all of this except Delete.

## Gotchas

- The folder browser starts in the server's real home folder (the run doesn't change `HOME`), so it lists the real folders there; it only reads names. Type the fixture's path right away rather than browsing from home.
- Only opening the folder again (by path, **Open a game…** or **Choose folder…**) rescans the text; the sidebar and the own address don't. A change to the game's data files shows only after the rescan.
- Moving the game folder gives it a new id.
