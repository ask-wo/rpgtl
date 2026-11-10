# Translation card

The overview's **Translation** card holds the game's translation switch, **Translate this game**, saved as `translate` in the catalog. Off (the default for a newly opened game), the game is served with its original text and the card shows one line; on, it counts the translation, offers **Export**, **Import…** and **Clear all…**, and holds the translator and image reading settings, which every game shares.

## Sub-features

- `tc-switch` the switch: saved in `$RUN/state/games/<id>/catalog.json`, and decides whether `/game/<id>/data/*.json` and `js/plugins.js` are translated.
- `tc-off-line` the off line: with translations, how many are kept; without, a pointer to switching it on.
- `tc-counts` text entries translated, entries in images (only when the game has image text) and glossary terms.
- `tc-language` **Game language** (`#game-language`): "<language> (Automatic)" until another is chosen, saved as `language` in the catalog; choosing the first option again removes it.
- `tc-export` **Export** downloads the saved catalog with its image text.
- `tc-import` **Import…** first shows what the chosen file changes (`POST /api/import/preview`: translations new, changed and cleared, glossary terms, images read before), then takes it after backing up the catalog. While an import puts images together, the button counts them (`importing` in `GET /api/activity`) and the card's actions are locked.
- `tc-clear` **Clear all…** asks, backs up, clears every translation and leaves the switch on.
- `tc-translator` translator, **Reload models** next to it, model, glossary model, sampling, **Thinking** (Off/On for Ollama, the model's effort levels for Claude and Codex), **Glossary thinking** (Claude and Codex), Claude's and Codex's models from their CLIs' live lists and options, saved to `$RUN/config/rpgtl/settings.json` as each is chosen.
- `tc-image-reading` backup reader and faint text, saved the same way.
- `tc-local-models` **Local models**, shown while Ollama translates or a backup reader is chosen: Ollama endpoint, **Runs in** (Ollama or llama-server, which is greyed out with the reason where it can't run) and, for llama-server, **Expert layers in system RAM** (Automatic or at least a number).

## How to get to it (user POV)

- A game's overview: its row in the sidebar, or opening it.

## Driving it with drive.ts

Preconditions:

- Fixture game open. `examples/translation-card.ts` is a complete, passing steps file for all of the above except Export's download and the Ollama, Codex and image reading fields.
- `examples/game-language.ts` is a complete, passing steps file for `tc-language`.

- **Switch.** `page.click('label[for="translate-game"]')` (Base UI puts the id on a hidden input). Read the catalog file's `translate`, and fetch `/game/<id>/data/CommonEvents.json` from the page to see which text is served.
- **Import.** The file input is hidden: get its `objectId` with `page.send("Runtime.evaluate", { expression: 'document.querySelector(\'input[type="file"]\')' })`, then `page.send("DOM.setFileInputFiles", { files: [path], objectId })` after `DOM.enable`.
- **Clear all.** `page.clickText("Clear all…")`, then `page.clickText("Clear all translations")` in the dialog; **Keep them** cancels. Count `$RUN/state/games/<id>/backups/`.
- **Selects.** Base UI selects are buttons with `role="combobox"` and the field's id (`#translator`, `#model`, `#expert-layers`, …). Click one, wait for `[role="option"]`, and click the option by its text through `page.eval`.

## Gotchas

- The server asks the real Ollama at the saved endpoint for its models and a model's layers, so the Model list and **Expert layers in system RAM** depend on this machine.
- Full-page screenshots cut a dialog's backdrop and the sidebar at the window's height; they are fixed to the viewport.
