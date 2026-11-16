# Missing images

When the game's data asks for a face, character sprite or picture that the game doesn't ship, the overview's warning lists it with the data files that ask for it and says it shows blank. The game scripts load a transparent pixel in its place in both play modes.

## Sub-features

- `img-list` each missing path with the files that ask for it, in the overview's warning.
- `img-case` a file that differs only in letter case is not listed.

## How to get to it (user POV)

- The warning at the top of an opened game's overview; it is hidden when nothing is missing.

## Driving it with drive.ts

Preconditions:

- The fixture ships every image it asks for. Remove `img/characters/Actor1.png` from `run.game` before opening the game; the actor and an event of `Map002.json` ask for it. `examples/missing-images.ts` is a complete, passing steps file for both sub-features.

- **List.** `page.waitUntil('document.body.textContent.includes("img/characters/Actor1, asked for in Actors.json, Map002.json")')`, and "Replaced with a blank image." in the title.
- **Case.** Rename the file back as `actor1.png` and open the game again by path; `Actor1` is no longer listed.
- **Proof.** Screenshots of the warning before and after.

## Gotchas

- Files added to the game folder only show after the game is opened again by path.
- Whether the blank image looks acceptable needs a check in a real game; list it in your report.
