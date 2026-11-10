# Text in images

RPGTL reads the text in a game's pictures, title and system images into entries, erases it and saves the erased background; the game draws the translated English into the bitmap as it loads. The page's **Images** page (`/games/<id>/images`, under the open game in the sidebar while its translation is on) shows the images with text, and the run bar there offers **Read new images**.

## Sub-features

- `img-read` **Read new images** in the run bar creates entries for images with Chinese text; the bar says "Checking which images are new or changed" until it knows the count, then "Reading images · n of m" and "Image reading done: …" after.
- `img-again` **Read all again** in the run bar, and **Read again** in an image's dialog, start a run with `again: "all"` or `again: ["<image>"]`, which reads those images from scratch. Each text keeps its translation and choices; one whose text reads differently gets a flag. A read again that fails keeps the image's last result, with a warning. Image reading starts with a backup of the catalog.
- `img-weight` **English lettering weight** (`#lettering-weight`: Original weight, Always bold, Never bold) and **English lettering font** (`#lettering-font`) save as they are chosen (`imageBold`, `imageFont` in the catalog) through `POST /api/catalog/images`; the preview beside them shows the game's own short image translations in that lettering.
- `img-clear` **Clear image text…** asks in an alert dialog, then deletes this game's image reads, erased copies and image entries including their translations. Ordinary translations are kept; edits waiting to save are saved first. Disabled while a run goes.
- `img-faint` **Faint text** in the overview's Translation card skips almost invisible lettering. **Include very faint text** restores those detections on the next reading, using the cached read. The choice is kept in settings.
- `img-view` the grid (`[aria-label="Images"]`, 48 per page) shows each read image with text as a card (canvas thumbnail, name, folder, "n of m translated"), with a search box and the filters All, With untranslated text, With original artwork kept. A card (`[aria-label="Open <image>"]`) opens a dialog: the original next to a canvas with the English drawn by the game's `drawImageText` from what was typed, **Show this image unchanged** (`label[for="show-unchanged"]`, saves `unchangedImages`), and each text (`[role="group"][aria-label="<source>"]`) with its English and **Keep original artwork** (saves the entry's `keepOriginal`). The pencil (`[aria-label="Correct <source>"]`) opens a box for the text read (`[aria-label="Text in the image for <source>"]`) with **Save** and **Cancel**: **Save** posts `text` to `/api/entries`, which keeps the entry's id, sets its `source` to the correction and `readerText` to what was read, and drops English a run gave (kept as `previous`); **Use it** under a corrected text sends the text read back. Reading the image again keeps a correction while the text reads the same. Every change saves itself; Alt+←/→ step through the images listed when it opened.
- `img-export` **Export** on the overview adds `images`: each image's read result with only the patches of its erased background that differ from the game's image, and `imageRuns`: the models each image reading run used and how many images it read. **Import…** of such a file draws the patches over the game's images again, without the reader.
- `img-draw` the game's bitmap for a translated image is drawn before it is ready; untranslated blocks keep the original pixels.

## How to get to it (user POV)

- **Images** in the sidebar of an opened game whose translation is on; translated image blocks show in the game opened with **Play in browser**.

## Driving it with drive.ts

Preconditions:

- Fixture game open (MV or MZ run). `examples/image-text.ts` is the complete recipe: it writes `img/pictures/Test.rpgmvp` (or `.png_` for MZ) and a plain `Test.png`, adds an `encryptionKey` to the game's `System.json`, and starts a fake reader with its `fakeReader`, which answers `/read` and `/prepare`.
- The server finds the reader at `RPGTL_IMAGE_READER`, read once at start; with it set, the page reads without asking to set the reader up, and Settings' **Image reader** card names the address. `launch.sh` always sets it, so under `launch.sh` the **Set up the image reader?** dialog never appears and nothing downloads the real reader: unless the variable is already set, it picks a free port, points the server there and writes the address to `$RUN/reader-url`, where `fakeReader(run, lines)` from `examples/image-text.ts` listens. `/health` names made-up models, which each image run saves, and every other route gets an empty 200, which covers the `/unload` RPGTL sends after reading. To use the real reader, start it by hand as `docs/testing.md` says and start the run with `RPGTL_IMAGE_READER=http://127.0.0.1:5001`.
- **Open.** `openImages(page, run)` from `examples/image-text.ts` opens the game, turns its translation on and opens its Images page.
- **Read.** `readImages(page, api, id)` clicks **Read new images**, waits for the run through `api("images/read?id=<id>")` and for the bar's "Image reading done". The card `[aria-label="Open img/pictures/Test"]` appears without reopening the game.
- **Translate one block.** Open the card, `page.fill(page.labelled("English for 开始游戏", "textarea"), "Begin")`, and wait for the catalog file to hold it.
- **Draw.** The fixture game's `$dataSystem` is static, so copy `rpgtlImageText` from `/game/<id>/data/System.json` into it in the game tab (`openPage("/game/<id>/")`), call `ImageManager.loadBitmap("img/pictures/", "Test")` and poll `isReady()` with `setTimeout(0)`: the pixels at the first ready poll must already be drawn. Read pixels with `bitmap.context.getImageData`.
- **Weight.** `page.select("#lettering-weight", "Always bold")`, wait for the catalog's `imageBold`, reload: the select keeps its value and the served block has `bold: true`.
- **Clear.** `clickText("Clear image text…")`, then **Clear image text** in `[role="alertdialog"]`; check that image entries and `$RUN/state/games/<id>/images.json` are gone.
- **Faint text.** Seed or read an image with a visible name, dim text and a faint single-character watermark. **Skip very faint text** keeps the name and dim text without a partial-read warning. Choose **Include very faint text** in the Translation card's **Faint text** and read again: the watermark entry returns without OCR; the visible name's translation survives.
- **Image view and export.** `examples/image-view.ts`: opens the image's card, checks the dialog canvas's pixels before and after typing, after **Keep original artwork** and **Show this image unchanged**, checks the served `System.json` after each save, then catches the exported file by replacing `HTMLAnchorElement.prototype.click`. The fixture game ships no font, so the view draws in sans-serif there.
- **Correcting a text.** `examples/image-correction.ts`: types English for a misread text, corrects the text with the pencil and **Save**, checks the entry keeps its id and English with `readerText` set, then **Read again** keeps the correction and **Use it** restores the text read.
- **Proof.** Screenshots of the page and the game tab, `drawn-bitmap.png` from the bitmap's canvas, the facts line in `actions.log`.

## Gotchas

- Encrypted images are read from `.rpgmvp` (MV) or `.png_` (MZ), but the fake engine loads the plain `.png` by URL, so both files are needed.
- The fixture's fake `Bitmap` has the engines' loading hooks but not their decryption or pixi textures. The real `Bitmap` is checked separately by loading the engine core files of a local game into a scratch page; those files are never committed.
- A select's trigger text ends with its arrow icon's glyph; compare with `includes`, not `===`.
- Whether the English looks right in a real game's font, with real images, needs a check in a real game; list it in your report.
