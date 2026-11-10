# Missing images

When the game's data asks for a face, character sprite or picture that the game doesn't ship, the overview's warning lists it with the data files that ask for it and says it shows blank. The game scripts load a transparent pixel in its place in both play modes.

## Sub-features

- `img-list` each missing path with the files that ask for it, in the overview's warning.
- `img-case` a file that differs only in letter case is not listed.

## How to get to it (user POV)

- The warning at the top of an opened game's overview; it is hidden when nothing is missing.

## Driving it with drive.ts

Preconditions:

- Fixture game open. The fixture's actor uses `Actor1` with no `img/characters/` folder, so the overview's warning shows `img/characters/Actor1` asked for in `Actors.json`.

- **List.** `page.waitUntil('document.body.textContent.includes("img/characters/Actor1")')`, with `Actors.json` beside it and "Replaced with a blank image." in the title.
- **Case.** Before launch, or with the game reopened, add `actor1.png`: `mkdir -p $RUN/game/img/characters && cp <any png> $RUN/game/img/characters/actor1.png`, open the game again by path; `Actor1` is no longer listed.
- **Proof.** Screenshots of the warning before and after.

## Gotchas

- Files added to the game folder only show after the game is opened again by path.
- Whether the blank image looks acceptable needs a check in a real game; list it in your report.
