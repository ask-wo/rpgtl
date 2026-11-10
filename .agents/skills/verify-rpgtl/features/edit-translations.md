# Edit translations on the Text page

The Text page lists the game's text (everything but the text in images) with each original beside its English. English typed there saves itself through `POST /api/entries` shortly after typing stops, without a backup, and the game gets it on its next load. A tree, a search and filters narrow the list, and the address keeps them. Export, import and clear all are on the overview's Translation card ([translation-card.md](./translation-card.md)).

## Sub-features

- `text-type` typing into an entry saves it once typing pauses; the header says "Saving…", then "All changes saved", and the sidebar's Text count (text entries without English) and the run bar's counts follow.
- `text-control-codes` English that drops one of the original's control codes is refused: the entry and the header say why, and the catalog keeps the old English.
- `text-tree` **All files**, the areas (Maps, Database, System, Plugins) and their files, each with how many entries the filter and search show; a map file shows its map's name.
- `text-search` the search box looks through the originals and the English of the selection.
- `text-filter` **All**, **Untranslated**, **Failed**, **Last run** and **Flagged**, each with its count; Previous and Next page through 50 entries at a time.
- `text-suggestion` an entry whose last answer was rejected shows it with **Use**; one the last run changed shows its English before the run with **Use the old one**.
- `text-flagged` **Flagged** lists translations a check (`pnpm run audit`'s) or a run flagged, each with `Check: …`; editing the English clears it.
- `text-address` the file or area, search and filter are in the address (`?file=Items.json&q=potion&show=untranslated`), so a reload keeps them.
- `text-failed-link` after a run with failed text entries, the run bar's **Show the N failed text entries** opens the page on Failed.
- `text-locked` the English can't be edited while a run goes.

## How to get to it (user POV)

- **Text** under the open game in the sidebar (`a[href$="/text"]`), shown while the game's translation switch is on.
- The run bar's link after a run with failed entries.
- `/games/<id>/text` with search params.

## Driving it with drive.ts

Preconditions:

- Fixture game open, translation switch on (`label[for="translate-game"]`). `examples/text.ts` is a complete, passing steps file for `text-type`, `text-control-codes`, `text-tree`, `text-search`, `text-filter`, `text-flagged` and `text-address`.

- **Type.** `page.fill('textarea[aria-label="English for 这把剑很重，你要小心。"]', …)`, wait until `$RUN/state/games/<id>/catalog.json` holds it, then for "All changes saved". `$RUN/state/games/<id>/backups/` gains nothing, and `fetch(run.url + "/game/<id>/data/CommonEvents.json")` serves the English.
- **Control codes.** Fill the `Recover \V[1] HP.` box without `\V[1]`: the page shows "Keep the original's RPG Maker control codes…" and the catalog's entry stays empty.
- **Tree, search and filter.** The tree is `nav[aria-label="Text files"]`; its buttons read label then count ("Items2"), so click them with a RegExp: `page.clickText(/^Items/, 'nav[aria-label="Text files"]')`. The search box is `[aria-label="Search the text"]`, the filters are buttons reading label then count ("Flagged1"). The entries are in `[aria-label="Entries"]`.
- **Flagged.** Type English with Chinese left in it ("This sword 很重, so be careful."), wait for the save, and the Flagged button reads `Flagged1`; choosing it shows `Check: Chinese left. Editing the English clears this.`, and `api("checks?id=" + id)` returns the finding.
- **Failed link and suggestions.** Need a run with failed entries; a real run rarely fails on the fixture. The page's component tests (`apps/web/src/text/TextPage.test.tsx`, `apps/web/src/translation/RunBar.test.tsx`) cover them.
- **Proof.** Screenshots after each step, and a copy of `$RUN/state/games/<id>/catalog.json` in evidence.

## Gotchas

- In a CSS attribute selector a backslash starts an escape: build the `\V[1]` entry's selector with `page.labelled(…)`.
- Edits reach the game only after it reloads; the served `/game/<id>/data/*.json` changes as soon as the save finishes.
- Image text isn't on this page; the Images page edits it.
