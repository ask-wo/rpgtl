# Glossary

The words the code and these docs are built from. Use them in code, tests, docs and conversation. How the parts work together and why is in [architecture.md](architecture.md).

## Games and state

| Term | Meaning |
| --- | --- |
| State folder | RPGTL's data folder (`RPGTL_DIR`, `StateFolder`): the game list `games.json` and a folder of files per game. |
| Game | An RPG Maker game folder that RPGTL has inspected (`Games`): an unpacked MV or MZ game, or an XP game, whose data may be in its `Game.rgssad` archive. Its **engine** is MV, MZ or XP, and `engineFeatures` says what RPGTL can do with it besides translating its text. |
| Game id | The random id a game gets when first inspected. It names the game's state folder and its addresses, and stays when the folder moves or a new version replaces the game. The same game opened on another computer gets another id, so an import matches a translation file to the game by its entry ids instead. |
| Game identity | What a game's `System.json` carries that is taken to stay the same across its versions: MZ's game id and the encryption key. With the title, it tells that a game in a new folder is another version of a saved game. |
| Build | One version of a game, told apart by System.json's `versionId` and a hash of its data and plugin files; its version, written like `v0.41`, is the one in the folder's name, its parent's name or else the game's title, which the page shows without it. |
| Inspecting | Reading a game folder's data and plugin files into the game list and its catalog. Opening a listed game shows what was saved and doesn't inspect it again. |
| Hold | An operation such as a run or a save holds a game, so others don't write it meanwhile. |

## Catalog

| Term | Meaning |
| --- | --- |
| Catalog | A game's entries, translations, translation glossary and settings, `catalog.json` in its folder (`Catalogs`). Translations live only here, never in the game files. **Export** writes it as a **translation file**, with the image text. |
| Game language | The language of a game's text, Chinese, Japanese or Korean (`SourceLanguage`). The player picks it on the Translation card and the catalog keeps it as `language`; without a pick it is guessed from how much of the text is Hangul or kana (`gameLanguage`). A run's prompts and its pronoun clues are written for it. |
| Backup | A copy of the catalog kept before a change to all of it, such as inspecting, importing, clearing or the start of a run. A run's saves after each batch and single edits don't make one. |
| Entry | One unit of translatable text in the catalog, with its source, translation and where it is. A message is one entry, not one per line. |
| Guess, user value | Two layers of an entry's English and of a glossary term's English, kind and pronoun (`Guessed`). The guess is what a run gave, with the run's start time, or RPGTL's rules, without one; the user value is the player's own and wins over the guess. Runs and rules write only guesses and the player only user values, so the user value never hides what the run said, and **Use it** goes back to the guess. A user value equal to the guess isn't kept. |
| Name entry | An entry that is a name, such as an actor's or a map's. The glossary pass translates these. |
| Location | Where an entry's text is (`Location`), such as a message in a map event's page, a field of a database record or lines of an image, with the map, table or image it is in. The catalog keeps each entry's location; only the code for MV and MZ turns one into a data file and the keys inside it. |
| Place | The part of the game a location is in: a map, a database table, the common events, the troops, the system settings, the plugins, an image or one of an XP game's Ruby scripts (`Place`). Batches and the Text page's tree group text by place. |
| Message | One Show Text or scrolling text command with all its lines, as one message window shows it. |
| Control code | Text the engine or a plugin interprets instead of showing, such as `\C[2]`, `%1` or a `\n<Name>` speaker tag. A translation keeps it unchanged. |
| Extract, apply | Extracting reads a game's files into entries; applying writes translations into the game's data as it loads, never into its files. |

## Translating

| Term | Meaning |
| --- | --- |
| Translator | Ollama, llama-server, Claude or Codex. A run's `Translator` is one of them set up for the run: a model per pass, batch size, requests at once. |
| Translation run | One press of **Translate** or **Build glossary**: the translation of a game's untranslated entries, saved after each batch, with its own **run log** (`Runs`). |
| Run kinds | Translation runs and image reading, which take turns across all games since both load models into the same memory (`RunKinds`). Translation runs go on together; images are read in one game at a time. A run that can't start yet **waits** for its turn, in the order runs were asked for. |
| Pass | A part of a translation run with its own model: the **glossary pass** fills the translation glossary, then the **text pass** translates the rest with it. |
| Batch | The entries one translation request asks about, from one scene or file. |
| Translation glossary | A game's source terms with the English the translator must use. Not this file. |
| Term kinds | What a translation glossary term is: a **character** (the only kind with a pronoun), a **name** (any other proper name) or a **word** (an ordinary word or shared label). |
| Checks | What a translation must pass, such as keeping its control codes and the glossary's English. A failed answer is asked again; `pnpm run audit` lists the findings left in a game. |
| Comparison | Several translator setups run side by side on a sample of a game's entries. |

## Image text

| Term | Meaning |
| --- | --- |
| Image text | Entries read from a game's images. |
| Image reading | A run that reads a game's images with the **image reader** (`apps/image-reader`), and with the **fallback reader** (the page's **Backup reader**), a vision model, where it isn't sure. |
| Erased background | A copy of an image with its text filled in, which the English is drawn on. The state folder keeps the whole copy, but a translation file carries only the tiles where it differs from the game's image (`erasedPatches`). |
| Lettering | Drawing an image text entry's English into its erased background, by the game, the page and, for an XP game, the server alike (`lettering.ts`). |
| Limit, room | The limit is how many characters the translator is asked to keep an image text entry within. The room is the space its English may be drawn in, which sets its size. |

## Playing

| Term | Meaning |
| --- | --- |
| Browser play | A game played in the browser from RPGTL's server, which applies the translations to the files it serves (`Play`). |
| RPGTL launch | Starting a game with Play (`Launches`): an MV or MZ game in RPGTL's own NW.js with the **NW.js hook**, which reads the catalog from disk and applies it, and an XP game in mkxp-z, which reads the translated data files RPGTL writes first. Starting the game through its own `Game.exe` is unaffected. |
| Patch | A zip of an XP game's translated data files, the tiles of its translated images and a readme (`XpPatch`), which the player copies over the game's own files to play it in `Game.exe` without RPGTL. |
| Fix | A Ruby file in an XP game's state folder (`games/<id>/fixes/*.rb`) that fixes a bug in the game's own scripts (`XpFixes`). Each one that is on goes into the scripts Play and the **patch** use, whether or not the game is translated. The user writes fixes; RPGTL never does. |
| Unpack | Writing the files of an XP game's archive into its folder and renaming the archive to `Game.rgssad.original` (`XpPatch`), so `Game.exe` loads loose files such as a **patch**'s. The one change RPGTL makes in a game folder, and only when the player asks; RPGTL still reads the game's text from the renamed archive. |
| Translation switch | A game's **Translate this game** switch. Off, the game shows its original text; it doesn't start or stop a run. |
| Script text | The strings in an XP game's Ruby scripts (`Scripts.rxdata`) that hold Chinese, Japanese or Korean, which the game draws itself, such as its title menu. Not RPGTL's **game scripts**. |
| Keep original | An entry the game shows as it is and runs don't translate: an image text's original artwork, or a string of **script text**. |
| Game scripts | The scripts RPGTL adds to a played game (`packages/game`): the **runtime** (fitting English into windows, the F8 panel) and the **map view** (F7). |
| Activity | Everything running for a game (its runs, image reading, the program it plays in) as the one stream its page follows (`Activity`). |
