# RPGTL verification map

This folder is the maintained source for verifying RPGTL's user-facing behaviour. Read this index before driving the app, then use the matching feature file as the recipe. Keep it current when a feature's entry points or proof change.

## Baseline preconditions

- A run started with `scripts/launch.sh <name>`: isolated `RPGTL_DIR`, `XDG_CONFIG_HOME` and port, and the fixture game in `$RUN/game/` (28 entries on MV, including translated event, switch and variable names; two entries are Chinese dialogue under the speaker `向导`).
- `scripts/doctor.sh "$RUN"` prints only `ok` lines.
- Never drive an instance this run did not start, and never a real game. Real-game checks go into your report as open items.

## Driving conventions

- Every recipe starts from a freshly opened fixture game unless it says otherwise. Opening it is the first lines of `examples/open-game.ts`.
- Use the ids and `aria-label`s named in the recipes, and `page.clickText` for dynamic buttons without ids.
- Do the action through the page; use `api(...)` and files only to read the result.

## Proof and skip reporting

- A screenshot of the action and of the result, plus `actions.log`.
- A second view of every stored change: the catalog file in `$RUN/state/`, the served game data, or a page reload.
- Copy state files you cite into `$RUN/evidence/` before cleanup.
- Name the entry point you used. An entry point you could not reach (folder picker, NW.js window, real-game rendering) is reported as not verified, with the reason; don't claim it through another path.

## Feature entry contract

Each file starts with an H1 and one paragraph, then four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.ts` (starts with `Preconditions:`), `Gotchas`.

## Features

- [Open a game](./open-game.md): path field, recent games list, the game's own address, removing a game.
- [Translation card](./translation-card.md): the translation switch, counts, export, import, clear all, translator and image reading settings.
- [Edit translations](./edit-translations.md): the Text page (file tree, search, filters, edits that save themselves, check notes).
- [Machine translation](./machine-translation.md): Translate in the run bar with Ollama, Claude or Codex, progress, the card locked meanwhile, stop, failed entries; `pnpm run audit` afterwards.
- [Glossary](./glossary.md): the Glossary page (list by kind, edit, add, remove, clear the translations that don't use a term) and Build glossary.
- [Play in browser](./play-in-browser.md): the game served with translations and the F8 panel; NW.js mode.
- [Missing images](./missing-images.md): the overview's warning about images the game asks for but lacks, which show blank.
- [Text in images](./image-text.md): the Images page and Read new images with a fake reader, the lettering, Clear image text, and the bitmap the game draws with the English.
